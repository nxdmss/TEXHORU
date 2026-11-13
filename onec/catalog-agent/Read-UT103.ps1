# Read-only UT 10.3 COM adapter. No documents or register writes.
function Invoke-OneCMethod($Object, [string[]]$Names, [object[]]$Arguments = @()) {
    $lastError = $null
    foreach ($name in $Names) {
        try {
            $method = $Object.PSObject.Methods[$name]
            if ($method) { return $method.Invoke($Arguments) }
        } catch { $lastError = $_ }
        try { return $Object.GetType().InvokeMember($name, [Reflection.BindingFlags]::InvokeMethod, $null, $Object, $Arguments) }
        catch { $lastError = $_ }
    }
    if ($lastError) { throw $lastError }
    throw ('ONEC_METHOD_NOT_FOUND:' + ($Names -join '/'))
}
function Set-OneCProperty($Object, [string[]]$Names, $Value) {
    foreach ($name in $Names) {
        try {
            $property = $Object.PSObject.Properties[$name]
            if ($property) { $property.Value = $Value; return }
        } catch {}
        try { $null = $Object.GetType().InvokeMember($name, [Reflection.BindingFlags]::SetProperty, $null, $Object, @($Value)); return }
        catch {}
    }
    throw ('ONEC_PROPERTY_NOT_FOUND:' + ($Names -join '/'))
}
function Select-OneCQuery($Query) {
    $result = Invoke-OneCMethod $Query @('Выполнить', 'Execute')
    return Invoke-OneCMethod $result @('Выбрать', 'Select')
}
function Move-OneCSelection($Selection) { return [bool](Invoke-OneCMethod $Selection @('Следующий', 'Next')) }
function Get-StableOneCId([string]$Kind, [string]$Code) {
    $value = $Code.Trim()
    if (-not $value) { throw 'ONEC_REFERENCE_CODE' }
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hex = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes(([string]$script:config.BaseId + '|' + $Kind + '|' + $value))))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    # RFC 4122-shaped, deterministic version-5 identifier. UT 10.3 catalog
    # codes are unique and remain available even when its old COMConnector
    # hides the native reference UUID from external connections.
    $hex = $hex.Substring(0, 12) + '5' + $hex.Substring(13, 3) + '8' + $hex.Substring(17)
    return $hex.Substring(0, 8) + '-' + $hex.Substring(8, 4) + '-' + $hex.Substring(12, 4) + '-' + $hex.Substring(16, 4) + '-' + $hex.Substring(20, 12)
}
function Get-RefId($Reference, [string]$Kind = 'REFERENCE', [string]$Code = '') {
    if ($Code) { return Get-StableOneCId $Kind $Code }
    try {
        $id = ([string](Invoke-OneCMethod $Reference @('УникальныйИдентификатор', 'UUID'))).ToLowerInvariant()
        if ($id -match '^[0-9a-f-]{36}$') { return $id }
    } catch {}
    # Old external connections can hide UUID() on references while exposing
    # the equivalent global XMLString(reference) conversion through IDispatch.
    foreach ($name in @('XMLString', 'XMLСтрока', 'ValueToStringInternal', 'ЗначениеВСтрокуВнутр')) {
        try {
            $xml = [string]$script:connection.GetType().InvokeMember($name, [Reflection.BindingFlags]::InvokeMethod, $null, $script:connection, @($Reference))
            if ($xml -match '(?i)[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}') { return $Matches[0].ToLowerInvariant() }
        } catch {}
    }
    try { $Code = ([string]$Reference.Код).Trim() } catch {}
    if ($Code) { return Get-StableOneCId $Kind $Code }
    throw 'ONEC_REFERENCE_ID'
}
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
    Set-OneCProperty $query @('Текст', 'Text') $Text
    foreach ($key in $Parameters.Keys) { $null = Invoke-OneCMethod $query @('УстановитьПараметр', 'SetParameter') @($key, $Parameters[$key]) }
    return $query
}
function Get-OneCRef([string]$Id) {
    if (-not $Id) { return $null }
    # Some older UT 10.3 COMConnector builds do not expose catalog-manager
    # methods (ПустаяСсылка/ПолучитьСсылку) to PowerShell. Resolve a selected
    # group through a plain query instead; root jobs never need this lookup.
    $query = New-OneCQuery 'ВЫБРАТЬ Н.Ссылка КАК Ref, Н.Код КАК Code ИЗ Справочник.Номенклатура КАК Н ГДЕ Н.ЭтоГруппа' @{}
    $selection = Select-OneCQuery $query
    while (Move-OneCSelection $selection) {
        if ((Get-RefId $selection.Ref 'GROUP' ([string]$selection.Code)) -eq $Id.ToLowerInvariant()) { return $selection.Ref }
    }
    throw 'GROUP_NOT_FOUND'
}
function Get-GroupPath($Reference) {
    $code = ([string]$Reference.Код).Trim()
    if (-not $code) { return 'Без категории' }
    $id = Get-RefId $Reference 'GROUP' $code
    if ($script:paths.ContainsKey($id)) { return $script:paths[$id] }
    $names = @(); $seen = @{}
    while ($code) {
        $key = Get-RefId $Reference 'GROUP' $code
        if ($seen.ContainsKey($key) -or $names.Count -ge 64) { throw 'GROUP_HIERARCHY' }
        $seen[$key] = $true; $names = @(([string]$Reference.Наименование).Trim()) + $names
        $Reference = $Reference.Родитель
        $code = ([string]$Reference.Код).Trim()
    }
    $path = $names -join ' / '
    if (-not $path) { $path = 'Без категории' }
    if ($path.Length -gt 500) { throw 'GROUP_PATH_LENGTH' }
    $script:paths[$id] = $path
    return $path
}
function Get-PriceType([string]$Name) {
    $query = New-OneCQuery 'ВЫБРАТЬ ПЕРВЫЕ 1 Т.Ссылка КАК Ref ИЗ Справочник.ТипыЦенНоменклатуры КАК Т ГДЕ Т.Наименование = &Name' @{ Name = $Name }
    $selection = Select-OneCQuery $query
    if (-not (Move-OneCSelection $selection)) { throw 'PRICE_TYPE_NOT_FOUND' }
    return $selection.Ref
}
function Read-RemotePage($Job) {
    $script:paths = @{}
    $parameters = @{}
    if ($Job.kind -eq 'GROUPS') { $condition = 'Н.ЭтоГруппа И НЕ Н.ПометкаУдаления' }
    else { $condition = 'НЕ Н.ЭтоГруппа' }
    $text = "ВЫБРАТЬ ПЕРВЫЕ 50 Н.Ссылка КАК Ref, Н.Код КАК Code, Н.Артикул КАК Article, Н.Наименование КАК Name, Н.НаименованиеПолное КАК FullName, Н.ВидНоменклатуры КАК ItemKind, Н.БазоваяЕдиницаИзмерения КАК Unit, Н.Родитель КАК Parent, Н.Родитель.Код КАК ParentCode, Н.ПометкаУдаления КАК Deleted ИЗ Справочник.Номенклатура КАК Н ГДЕ $condition"
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
    $selection = Select-OneCQuery $query
    $rows = @()
    while (Move-OneCSelection $selection) {
        $unitName = ''
        try { $unitName = ([string]$selection.Unit.Наименование).Trim() } catch { $unitName = ([string]$selection.Unit).Trim() }
        $rows += ,@{ Ref = $selection.Ref; Code = ([string]$selection.Code).Trim(); Article = ([string]$selection.Article).Trim(); Name = [string]$selection.Name; FullName = ([string]$selection.FullName).Trim(); ItemKind = ([string]$selection.ItemKind).Trim(); UnitName = $unitName; Parent = $selection.Parent; ParentCode = ([string]$selection.ParentCode).Trim(); Deleted = [bool]$selection.Deleted }
    }
    if ($rows.Count -eq 0) { return $null }
    $range = @{ FirstCode = $rows[0].Code; LastCode = $rows[-1].Code }
    $body = @{ leaseToken = [string]$Job.leaseToken; batch = [int]$Job.nextBatch; cursor = $rows[-1].Code; scanned = $rows.Count; products = @(); categories = @(); groups = @(); hashes = @() }
    if ($Job.kind -eq 'GROUPS') {
        $counts = @{}
        $query = New-OneCQuery 'ВЫБРАТЬ Н.Родитель КАК Ref, Н.Родитель.Код КАК Code, КОЛИЧЕСТВО(*) КАК Qty ИЗ Справочник.Номенклатура КАК Н ГДЕ НЕ Н.ЭтоГруппа И НЕ Н.ПометкаУдаления И Н.Родитель.Код >= &FirstCode И Н.Родитель.Код <= &LastCode СГРУППИРОВАТЬ ПО Н.Родитель, Н.Родитель.Код' $range
        $selection = Select-OneCQuery $query
        while (Move-OneCSelection $selection) { $counts[(Get-RefId $selection.Ref 'GROUP' ([string]$selection.Code))] = [int]$selection.Qty }
        foreach ($row in $rows) {
            $id = Get-RefId $row.Ref 'GROUP' $row.Code
            $parent = if ($row.ParentCode) { Get-RefId $row.Parent 'GROUP' $row.ParentCode } else { '' }
            $body.groups += @{ oneCId = $id; parentId = $parent; name = $row.Name.Trim(); itemCount = [int]$counts[$id] }
        }
        return $body
    }
    if ($script:config.RetailPriceName.Trim().ToLowerInvariant() -eq $script:config.PurchasePriceName.Trim().ToLowerInvariant()) { throw 'PRICE_TYPES_IDENTICAL' }
    $retail = Get-PriceType $script:config.RetailPriceName
    $purchase = Get-PriceType $script:config.PurchasePriceName
    $prices = @();
    foreach ($priceType in @($retail, $purchase)) {
        $map = @{}
        # An omitted slice date means the latest available record. Passing a
        # .NET DateTime through the legacy COMConnector is not portable: older
        # UT 10.3 builds reject it as the first virtual-table parameter.
        $query = New-OneCQuery 'ВЫБРАТЬ Ц.Номенклатура КАК Ref, Ц.Номенклатура.Код КАК Code, МАКСИМУМ(Ц.Цена) КАК Price, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Ц.Цена) КАК Variants ИЗ РегистрСведений.ЦеныНоменклатуры.СрезПоследних(, ТипЦен = &PriceType) КАК Ц ГДЕ Ц.Номенклатура.Код >= &FirstCode И Ц.Номенклатура.Код <= &LastCode И Ц.ХарактеристикаНоменклатуры = ЗНАЧЕНИЕ(Справочник.ХарактеристикиНоменклатуры.ПустаяСсылка) СГРУППИРОВАТЬ ПО Ц.Номенклатура, Ц.Номенклатура.Код' @{ PriceType = $priceType; FirstCode = $range.FirstCode; LastCode = $range.LastCode }
        $selection = Select-OneCQuery $query
        while (Move-OneCSelection $selection) {
            $price = [decimal]$selection.Price
            if ($selection.Variants -gt 1 -or $price -lt 0 -or $price -ne [decimal]::Truncate($price) -or $price -gt [int]::MaxValue) { throw 'PRICE_UNIT_OR_FRACTION' }
            $map[(Get-RefId $selection.Ref 'NOMENCLATURE' ([string]$selection.Code))] = [int]$price
        }
        $prices += ,$map
    }
    $stocks = @{}
    $query = New-OneCQuery 'ВЫБРАТЬ О.Номенклатура КАК Ref, О.Номенклатура.Код КАК Code, СУММА(О.КоличествоОстаток) КАК Qty ИЗ РегистрНакопления.ТоварыНаСкладах.Остатки() КАК О ГДЕ О.Номенклатура.Код >= &FirstCode И О.Номенклатура.Код <= &LastCode И О.ХарактеристикаНоменклатуры = ЗНАЧЕНИЕ(Справочник.ХарактеристикиНоменклатуры.ПустаяСсылка) СГРУППИРОВАТЬ ПО О.Номенклатура, О.Номенклатура.Код' $range
    $selection = Select-OneCQuery $query
    while (Move-OneCSelection $selection) {
        $qty = [decimal]$selection.Qty
        if ($qty -ne [decimal]::Truncate($qty) -or $qty -gt [int]::MaxValue) { throw 'STOCK_FRACTION' }
        $stocks[(Get-RefId $selection.Ref 'NOMENCLATURE' ([string]$selection.Code))] = [int][Math]::Max(0, $qty)
    }
    $categories = @{}
    foreach ($row in $rows) {
        $id = Get-RefId $row.Ref 'NOMENCLATURE' $row.Code
        $categoryId = if ($row.ParentCode) { Get-RefId $row.Parent 'GROUP' $row.ParentCode } else { Get-StableOneCId 'GROUP' '__ROOT__' }
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
