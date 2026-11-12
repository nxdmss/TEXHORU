# Read-only UT 10.3 COM adapter. No documents or register writes.
function Get-RefId($Reference) { return ([string]$Reference.УникальныйИдентификатор()).ToLowerInvariant() }
function New-OneCQuery([string]$Text, [hashtable]$Parameters) {
    $query = $script:connection.NewObject('Запрос')
    $query.Текст = $Text
    foreach ($key in $Parameters.Keys) { $query.УстановитьПараметр($key, $Parameters[$key]) }
    return $query
}
function Get-OneCRef([string]$Id) {
    if (-not $Id) { return $script:connection.Справочники.Номенклатура.ПустаяСсылка() }
    return $script:connection.Справочники.Номенклатура.ПолучитьСсылку($script:connection.NewObject('УникальныйИдентификатор', $Id))
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
    $value = $script:connection.Справочники.ТипыЦенНоменклатуры.НайтиПоНаименованию($Name, $true)
    if ((Get-RefId $value) -eq '00000000-0000-0000-0000-000000000000') { throw 'PRICE_TYPE_NOT_FOUND' }
    if (([string]$value.ВалютаЦены.Код).Trim() -notin @('643', 'RUB')) { throw 'PRICE_CURRENCY' }
    return $value
}
function Read-RemotePage($Job) {
    $script:paths = @{}
    $parameters = @{ After = (Get-OneCRef ([string]$Job.cursor)) }
    if ($Job.kind -eq 'GROUPS') { $condition = 'Н.ЭтоГруппа И НЕ Н.ПометкаУдаления' }
    else { $condition = 'НЕ Н.ЭтоГруппа' }
    $text = "ВЫБРАТЬ ПЕРВЫЕ 50 Н.Ссылка КАК Ref, Н.Наименование КАК Name, Н.Родитель КАК Parent, Н.Артикул КАК Sku, Н.ПометкаУдаления КАК Deleted ИЗ Справочник.Номенклатура КАК Н ГДЕ $condition И Н.Ссылка > &After"
    if ($Job.groupId -and $Job.kind -eq 'CATALOG') {
        $text += ' И Н.Ссылка В ИЕРАРХИИ(&Group)'
        $parameters.Group = Get-OneCRef ([string]$Job.groupId)
    }
    $text += ' УПОРЯДОЧИТЬ ПО Н.Ссылка'
    $query = New-OneCQuery $text $parameters
    $selection = $query.Выполнить().Выбрать()
    $rows = @(); $refs = $script:connection.NewObject('Массив')
    while ($selection.Следующий()) {
        $rows += ,@{ Ref = $selection.Ref; Name = [string]$selection.Name; Parent = $selection.Parent; Sku = [string]$selection.Sku; Deleted = [bool]$selection.Deleted }
        $null = $refs.Добавить($selection.Ref)
    }
    if ($rows.Count -eq 0) { return $null }
    $body = @{ leaseToken = [string]$Job.leaseToken; batch = [int]$Job.nextBatch; cursor = (Get-RefId $rows[-1].Ref); scanned = $rows.Count; products = @(); categories = @(); groups = @(); hashes = @() }
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
    $empty = $script:connection.Справочники.ХарактеристикиНоменклатуры.ПустаяСсылка()
    $retail = Get-PriceType $script:config.RetailPriceName
    $purchase = Get-PriceType $script:config.PurchasePriceName
    if ((Get-RefId $retail) -eq (Get-RefId $purchase)) { throw 'PRICE_TYPES_IDENTICAL' }
    $prices = @();
    foreach ($priceType in @($retail, $purchase)) {
        $map = @{}
        $query = New-OneCQuery 'ВЫБРАТЬ Ц.Номенклатура КАК Ref, МАКСИМУМ(Ц.Цена) КАК Price, КОЛИЧЕСТВО(РАЗЛИЧНЫЕ Ц.Цена) КАК Variants ИЗ РегистрСведений.ЦеныНоменклатуры.СрезПоследних(&Now, ТипЦен = &PriceType И Номенклатура В (&Refs) И ХарактеристикаНоменклатуры = &Empty) КАК Ц СГРУППИРОВАТЬ ПО Ц.Номенклатура' @{ Now = (Get-Date); PriceType = $priceType; Refs = $refs; Empty = $empty }
        $selection = $query.Выполнить().Выбрать()
        while ($selection.Следующий()) {
            $price = [decimal]$selection.Price
            if ($selection.Variants -gt 1 -or $price -lt 0 -or $price -ne [decimal]::Truncate($price) -or $price -gt [int]::MaxValue) { throw 'PRICE_UNIT_OR_FRACTION' }
            $map[(Get-RefId $selection.Ref)] = [int]$price
        }
        $prices += ,$map
    }
    $stocks = @{}
    $query = New-OneCQuery 'ВЫБРАТЬ О.Номенклатура КАК Ref, СУММА(О.КоличествоОстаток) КАК Qty ИЗ РегистрНакопления.ТоварыНаСкладах.Остатки(, Номенклатура В (&Refs) И ХарактеристикаНоменклатуры = &Empty) КАК О СГРУППИРОВАТЬ ПО О.Номенклатура' @{ Refs = $refs; Empty = $empty }
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
        $product = [ordered]@{ oneCId = $id; sku = '1C-' + $id; slug = '1c-' + $id; name = $row.Name.Trim(); brand = $brand; categoryOneCId = $categoryId; price = [int]$prices[0][$id]; costPrice = $prices[1][$id]; stockQty = [int]$stocks[$id]; isDeleted = $row.Deleted }
        if ($row.Deleted) { $product.stockQty = 0 }
        if ($row.Sku.Trim()) { $product.mpn = $row.Sku.Trim() }
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
        $used = @($body.products | ForEach-Object { $_.categoryOneCId })
        $body.categories = @($body.categories | Where-Object { $_.oneCId -in $used })
    }
    return $body
}
