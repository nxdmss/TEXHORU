# Read-only UT 10.3 COM adapter. No documents or register writes.
function Get-RefId($Reference) { return ([string]$Reference.УникальныйИдентификатор()).ToLowerInvariant() }
function New-OneCObject([string]$Type) {
    # COMConnector exposes global-context method names in the configuration's
    # script language. Some builds also hide global-context methods from
    # PowerShell's normal COM adapter while still exposing them through
    # IDispatch. Try both language variants and then invoke IDispatch directly.
    try { return $script:connection.NewObject($Type) }
    catch {
        try { return $script:connection.НовыйОбъект($Type) }
        catch {
            $aliases = @{ 'Запрос' = 'Query'; 'Массив' = 'Array' }
            $objectType = if ($aliases.ContainsKey($Type)) { $aliases[$Type] } else { $Type }
            return $script:connection.GetType().InvokeMember('NewObject', [Reflection.BindingFlags]::InvokeMethod, $null, $script:connection, @($objectType))
        }
    }
}
function New-OneCQuery([string]$Text, [hashtable]$Parameters) {
    $query = New-OneCObject 'Запрос'
    $query.Текст = $Text
    foreach ($key in $Parameters.Keys) { $query.УстановитьПараметр($key, $Parameters[$key]) }
    return $query
}
function Get-OneCRef([string]$Id) {
    if (-not $Id) { return $null }
    # Some older UT 10.3 COMConnector builds do not expose catalog-manager
    # methods (ПустаяСсылка/ПолучитьСсылку) to PowerShell. Resolve a selected
    # group through a plain query instead; root jobs never need this lookup.
    $query = New-OneCQuery 'ВЫБРАТЬ Н.Ссылка КАК Ref ИЗ Справочник.Номенклатура КАК Н ГДЕ Н.ЭтоГруппа' @{}
    $selection = $query.Выполнить().Выбрать()
    while ($selection.Следующий()) {
        if ((Get-RefId $selection.Ref) -eq $Id.ToLowerInvariant()) { return $selection.Ref }
    }
    throw 'GROUP_NOT_FOUND'
}
function Get-GroupPath($Reference) {
    $id = Get-RefId $Reference
    if ($script:paths.ContainsKey($id)) { return $script:paths[$id] }
    $names = @(); $seen = @{}
    while ((Get-RefId $Reference) -ne '00000000-0000-0000-0000-000000000000') {
        $key = Get-RefId $Reference
        if ($seen.ContainsKey($key) -or $names.Count -ge 64) { throw 'GROUP_HIERARCHY' }
        $seen[$key] = $true; $names = @(([string]$Reference.Наименование).Trim()) + $names
        $Reference = $Reference.Родитель
    }
    $path = $names -join ' / '
    if (-not $path) { $path = 'Без категории' }
    if ($path.Length -gt 500) { throw 'GROUP_PATH_LENGTH' }
    $script:paths[$id] = $path
    return $path
}
function Get-PriceType([string]$Name) {
    $query = New-OneCQuery 'ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ref, Т.ВалютаЦены.Код КАК Currency ИЗ Справочник.ТипыЦенНоменклатуры КАК Т ГДЕ Т.Наименование = &Name' @{ Name = $Name }
    $selection = $query.Выполнить().Выбрать()
    if (-not $selection.Следующий()) { throw 'PRICE_TYPE_NOT_FOUND' }
    if (([string]$selection.Currency).Trim() -notin @('643', 'RUB')) { throw 'PRICE_CURRENCY' }
    return $selection.Ref
}
function Read-RemotePage($Job) {
    $script:paths = @{}
    $parameters = @{}
    if ($Job.kind -eq 'GROUPS') { $condition = 'Н.ЭтоГруппа И НЕ Н.ПометкаУдаления' }
    else { $condition = 'НЕ Н.ЭтоГруппа' }
    $text = "ВЫБРАТЬ ПЕРВЫЕ 50 Н.Ссылка КАК Ref, Н.Код КАК Code, Н.Артикул КАК Article, Н.Наименование КАК Name, Н.НаименованиеПолное КАК FullName, Н.ВидНоменклатуры КАК ItemKind, Н.БазоваяЕдиницаИзмерения КАК Unit, Н.Родитель КАК Parent, Н.ПометкаУдаления КАК Deleted ИЗ Справочник.Номенклатура КАК Н ГДЕ $condition"
    if ($Job.cursor) {
        # Catalog codes are unique in UT 10.3 and are exposed as regular
        # strings even when reference-manager methods are unavailable.
        $text += ' И Н.Код > &AfterCode'
        $parameters.AfterCode = [string]$Job.cursor
    }
    if ($Job.groupId -and $Job.kind -eq 'CATALOG') {
        $text += ' И Н.Ссылка В ИЕРАРХИИ(&Group)'
        $parameters.Group = Get-OneCRef ([string]$Job.groupId)
    }
    $text += ' УПОРЯДОЧИТЬ ПО Н.Код'
    $query = New-OneCQuery $text $parameters
    $selection = $query.Выполнить().Выбрать()
    $rows = @(); $refs = New-OneCObject 'Массив'
    while ($selection.Следующий()) {
        $unitName = ''
        try { $unitName = ([string]$selection.Unit.Наименование).Trim() } catch { $unitName = ([string]$selection.Unit).Trim() }
        $rows += ,@{ Ref = $selection.Ref; Code = ([string]$selection.Code).Trim(); Article = ([string]$selection.Article).Trim(); Name = [string]$selection.Name; FullName = ([string]$selection.FullName).Trim(); ItemKind = ([string]$selection.ItemKind).Trim(); UnitName = $unitName; Parent = $selection.Parent; Deleted = [bool]$selection.Deleted }
        $null = $refs.Добавить($selection.Ref)
    }
    if ($rows.Count -eq 0) { return $null }
    $body = @{ leaseToken = [string]$Job.leaseToken; batch = [int]$Job.nextBatch; cursor = $rows[-1].Code; scanned = $rows.Count; products = @(); categories = @(); groups = @(); hashes = @() }
    if ($Job.kind -eq 'GROUPS') {
        $counts = @{}
        $query = New-OneCQuery 'ВЫБРАТЬ Н.Родитель КАК Ref, КОЛИЧЕСТВО(*) КАК Qty ИЗ Справочник.Номенклатура КАК Н ГДЕ НЕ Н.ЭтоГруппа И НЕ Н.ПометкаУдаления И Н.Родитель В (&Refs) СГРУППИРОВАТЬ ПО Н.Родитель' @{ Refs = $refs }
        $selection = $query.Выполнить().Выбрать()
        while ($selection.Следующий()) { $counts[(Get-RefId $selection.Ref)] = [int]$selection.Qty }
        foreach ($row in $rows) {
            $id = Get-RefId $row.Ref; $parent = Get-RefId $row.Parent
            if ($parent -eq '00000000-0000-0000-0000-000000000000') { $parent = '' }
            $body.groups += @{ oneCId = $id; parentId = $parent; name = $row.Name.Trim(); itemCount = [int]$counts[$id] }
        }
        return $body
    }
    $retail = Get-PriceType $script:config.RetailPriceName
    $purchase = Get-PriceType $script:config.PurchasePriceName
    if ((Get-RefId $retail) -eq (Get-RefId $purchase)) { throw 'PRICE_TYPES_IDENTICAL' }
    $prices = @();
    foreach ($priceType in @($retail, $purchase)) {
        $map = @{}
        $query = New-OneCQuery 'ВЫБРАТЬ Ц.Номенклатура КАК Ref, МАКСИМУМ(Ц.Цена) КАК Price, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Ц.Цена) КАК Variants ИЗ РегистрСведений.ЦеныНоменклатуры.СрезПоследних(&Now, ТипЦен = &PriceType И Номенклатура В (&Refs) И ХарактеристикаНоменклатуры = ЗНАЧЕНИЕ(Справочник.ХарактеристикиНоменклатуры.ПустаяСсылка)) КАК Ц СГРУППИРОВАТЬ ПО Ц.Номенклатура' @{ Now = (Get-Date); PriceType = $priceType; Refs = $refs }
        $selection = $query.Выполнить().Выбрать()
        while ($selection.Следующий()) {
            $price = [decimal]$selection.Price
            if ($selection.Variants -gt 1 -or $price -lt 0 -or $price -ne [decimal]::Truncate($price) -or $price -gt [int]::MaxValue) { throw 'PRICE_UNIT_OR_FRACTION' }
            $map[(Get-RefId $selection.Ref)] = [int]$price
        }
        $prices += ,$map
    }
    $stocks = @{}
    $query = New-OneCQuery 'ВЫБРАТЬ О.Номенклатура КАК Ref, СУММА(О.КоличествоОстаток) КАК Qty ИЗ РегистрНакопления.ТоварыНаСкладах.Остатки(, Номенклатура В (&Refs) И ХарактеристикаНоменклатуры = ЗНАЧЕНИЕ(Справочник.ХарактеристикиНоменклатуры.ПустаяСсылка)) КАК О СГРУППИРОВАТЬ ПО О.Номенклатура' @{ Refs = $refs }
    $selection = $query.Выполнить().Выбрать()
    while ($selection.Следующий()) {
        $qty = [decimal]$selection.Qty
        if ($qty -ne [decimal]::Truncate($qty) -or $qty -gt [int]::MaxValue) { throw 'STOCK_FRACTION' }
        $stocks[(Get-RefId $selection.Ref)] = [int][Math]::Max(0, $qty)
    }
    $categories = @{}
    foreach ($row in $rows) {
        $id = Get-RefId $row.Ref; $categoryId = Get-RefId $row.Parent
        $path = Get-GroupPath $row.Parent
        $brand = 'Другие'
        if ($row.Name -match '(?i)iphone|apple') { $brand = 'Apple' }
        elseif ($row.Name -match '(?i)samsung') { $brand = 'Samsung' }
        elseif ($row.Name -match '(?i)xiaomi|redmi|poco') { $brand = 'Xiaomi' }
        elseif ($row.Name -match '(?i)honor') { $brand = 'Honor' }
        elseif ($row.Name -match '(?i)huawei') { $brand = 'Huawei' }
        $product = [ordered]@{ oneCId = $id; sku = '1C-' + $id; slug = '1c-' + $id; name = $row.Name.Trim(); brand = $brand; categoryOneCId = $categoryId; price = [int]$prices[0][$id]; costPrice = $prices[1][$id]; stockQty = [int]$stocks[$id]; isDeleted = $row.Deleted; sourceCode = $row.Code; sourceArticle = $row.Article; sourceFullName = $row.FullName; sourceKind = $row.ItemKind; sourceUnit = $row.UnitName }
        if ($row.Deleted) { $product.stockQty = 0 }
        if ($row.Article) { $product.mpn = $row.Article }
        $category = [ordered]@{ oneCId = $categoryId; name = $path; slug = '1c-' + $categoryId }
        $json = [ordered]@{ product = $product; category = $category } | ConvertTo-Json -Depth 10 -Compress
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($json)))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
        $body.hashes += @{ oneCId = $id; hash = $hash }; $body.products += $product
        $categories[$categoryId] = $category
    }
    $body.categories = @($categories.Values)
    if ($Job.mode -eq 'DELTA') {
        $known = Invoke-AgentApi 'POST' 'known' @{ hashes = $body.hashes }
        $body.products = @($body.products | Where-Object { $_.oneCId -in @($known.needed) })
        # Keep bounded category paths to confirm which folders were scanned, including unchanged cards.
    }
    return $body
}
