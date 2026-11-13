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
function Get-OneCProperty($Object, [string[]]$Names, [bool]$Optional = $false) {
    $lastError = $null
    foreach ($name in $Names) {
        try {
            $property = $Object.PSObject.Properties[$name]
            if ($property) { return $property.Value }
        } catch { $lastError = $_ }
        try { return $Object.GetType().InvokeMember($name, [Reflection.BindingFlags]::GetProperty, $null, $Object, @()) }
        catch { $lastError = $_ }
        # Query selections in several old COMConnector builds publish columns
        # only through Получить/Get rather than normal automation properties.
        try { return Invoke-OneCMethod $Object @('Получить', 'Get') @($name) }
        catch { $lastError = $_ }
    }
    if ($Optional) { return $null }
    if ($lastError) { throw $lastError }
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
function Get-NomenclatureKey([string]$Code, [string]$Article, [string]$Name, [string]$FullName, [string]$ParentCode) {
    if ($Code.Trim()) { return $Code.Trim() }
    $fallback = ($Article.Trim() + '|' + $FullName.Trim() + '|' + $Name.Trim() + '|' + $ParentCode.Trim()).Trim('|')
    if (-not $fallback) { throw 'ONEC_NOMENCLATURE_KEY' }
    return 'NO_CODE|' + $fallback
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
        $ref = Get-OneCProperty $selection @('Ref')
        $code = ([string](Get-OneCProperty $selection @('Code'))).Trim()
        if (-not $code) { $code = ([string](Get-OneCProperty $ref @('Код', 'Code') $true)).Trim() }
        if ($code -and (Get-StableOneCId 'GROUP' $code) -eq $Id.ToLowerInvariant()) { return $ref }
    }
    throw 'GROUP_NOT_FOUND'
}
function Get-GroupPath($Reference) {
    $code = ([string](Get-OneCProperty $Reference @('Код', 'Code') $true)).Trim()
    if (-not $code) { return 'Без категории' }
    $id = Get-StableOneCId 'GROUP' $code
    if ($script:paths.ContainsKey($id)) { return $script:paths[$id] }
    $names = @(); $seen = @{}
    while ($code) {
        $key = Get-StableOneCId 'GROUP' $code
        if ($seen.ContainsKey($key) -or $names.Count -ge 64) { throw 'GROUP_HIERARCHY' }
        $name = ([string](Get-OneCProperty $Reference @('Наименование', 'Description') $true)).Trim()
        $seen[$key] = $true; $names = @($name) + $names
        $Reference = Get-OneCProperty $Reference @('Родитель', 'Parent') $true
        $code = ([string](Get-OneCProperty $Reference @('Код', 'Code') $true)).Trim()
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
    return Get-OneCProperty $selection @('Ref')
}
function Add-RemoteScope([string]$Text, [hashtable]$Parameters, $Job) {
    if ($Job.groupId) {
        $Text += ' И Н.Ссылка В ИЕРАРХИИ(&Group)'
        $Parameters.Group = Get-OneCRef ([string]$Job.groupId)
    }
    $excludedIndex = 0
    foreach ($excludedId in @($Job.excludedGroupIds)) {
        if (-not ([string]$excludedId).Trim()) { continue }
        $parameterName = 'ExcludedGroup' + $excludedIndex
        $Text += (' И НЕ Н.Ссылка В ИЕРАРХИИ(&' + $parameterName + ')')
        $Parameters[$parameterName] = Get-OneCRef ([string]$excludedId)
        $excludedIndex++
    }
    return $Text
}
function Read-RemoteIndexPage($Job) {
    $parameters = @{}
    $text = 'ВЫБРАТЬ ПЕРВЫЕ 200 Н.Ссылка КАК Ref, Н.Код КАК Code, Н.Артикул КАК Article, Н.Наименование КАК Name, Н.НаименованиеПолное КАК FullName, Н.Родитель КАК Parent, Н.Родитель.Код КАК ParentCode, Н.ПометкаУдаления КАК Deleted ИЗ Справочник.Номенклатура КАК Н ГДЕ НЕ Н.ЭтоГруппа'
    if ($Job.cursor) { $text += ' И Н.Код > &AfterCode'; $parameters.AfterCode = [string]$Job.cursor }
    $text = Add-RemoteScope $text $parameters $Job
    $text += ' УПОРЯДОЧИТЬ ПО Н.Код'
    $selection = Select-OneCQuery (New-OneCQuery $text $parameters)
    $items = @(); $lastCode = ''
    while (Move-OneCSelection $selection) {
        $ref = Get-OneCProperty $selection @('Ref')
        $parent = Get-OneCProperty $selection @('Parent')
        $code = ([string](Get-OneCProperty $selection @('Code'))).Trim()
        $parentCode = ([string](Get-OneCProperty $selection @('ParentCode'))).Trim()
        if (-not $code) { $code = ([string](Get-OneCProperty $ref @('Код', 'Code') $true)).Trim() }
        if (-not $parentCode) { $parentCode = ([string](Get-OneCProperty $parent @('Код', 'Code') $true)).Trim() }
        $article = ([string](Get-OneCProperty $selection @('Article'))).Trim()
        $name = ([string](Get-OneCProperty $selection @('Name'))).Trim()
        $fullName = ([string](Get-OneCProperty $selection @('FullName'))).Trim()
        $identityKey = Get-NomenclatureKey $code $article $name $fullName $parentCode
        $id = Get-StableOneCId 'NOMENCLATURE' $identityKey
        $parentId = if ($parentCode) { Get-StableOneCId 'GROUP' $parentCode } else { Get-StableOneCId 'GROUP' '__ROOT__' }
        $items += @{ oneCId = $id; parentId = $parentId; code = $code; article = $article; name = $name; deletionMark = [bool](Get-OneCProperty $selection @('Deleted')) }
        $lastCode = $code
    }
    if (-not $items.Count) { return $null }
    return @{ leaseToken = [string]$Job.leaseToken; batch = [int]$Job.nextBatch; cursor = $lastCode; scanned = $items.Count; products = @(); categories = @(); groups = @(); hashes = @(); indexItems = $items }
}
function Read-RemotePage($Job) {
    $script:paths = @{}
    if ($Job.kind -eq 'INDEX') { return Read-RemoteIndexPage $Job }
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
    if ($Job.kind -eq 'IMPORT') {
        $selected = @($Job.selectedCodes | Where-Object { ([string]$_).Trim() })
        if (-not $selected.Count) { throw 'SELECTION_EMPTY' }
        $conditions = @()
        for ($selectedIndex = 0; $selectedIndex -lt $selected.Count; $selectedIndex++) {
            $parameterName = 'SelectedCode' + $selectedIndex
            $conditions += ('Н.Код = &' + $parameterName)
            $parameters[$parameterName] = [string]$selected[$selectedIndex]
        }
        $text += ' И (' + ($conditions -join ' ИЛИ ') + ')'
    }
    if ($Job.kind -ne 'GROUPS') { $text = Add-RemoteScope $text $parameters $Job }
    $text += ' УПОРЯДОЧИТЬ ПО Н.Код'
    $query = New-OneCQuery $text $parameters
    $selection = Select-OneCQuery $query
    $rows = @()
    while (Move-OneCSelection $selection) {
        $ref = Get-OneCProperty $selection @('Ref')
        $unit = Get-OneCProperty $selection @('Unit')
        $parent = Get-OneCProperty $selection @('Parent')
        $unitName = ''
        try { $unitName = ([string](Get-OneCProperty $unit @('Наименование', 'Description'))).Trim() } catch { $unitName = ([string]$unit).Trim() }
        $code = ([string](Get-OneCProperty $selection @('Code'))).Trim(); $parentCode = ([string](Get-OneCProperty $selection @('ParentCode'))).Trim()
        if (-not $code) { $code = ([string](Get-OneCProperty $ref @('Код', 'Code') $true)).Trim() }
        if (-not $parentCode) { $parentCode = ([string](Get-OneCProperty $parent @('Код', 'Code') $true)).Trim() }
        $rows += ,@{ Ref = $ref; Code = $code; Article = ([string](Get-OneCProperty $selection @('Article'))).Trim(); Name = [string](Get-OneCProperty $selection @('Name')); FullName = ([string](Get-OneCProperty $selection @('FullName'))).Trim(); ItemKind = ([string](Get-OneCProperty $selection @('ItemKind'))).Trim(); UnitName = $unitName; Parent = $parent; ParentCode = $parentCode; Deleted = [bool](Get-OneCProperty $selection @('Deleted')) }
    }
    if ($rows.Count -eq 0) { return $null }
    $range = @{ FirstCode = $rows[0].Code; LastCode = $rows[-1].Code }
    $body = @{ leaseToken = [string]$Job.leaseToken; batch = [int]$Job.nextBatch; cursor = $rows[-1].Code; scanned = $rows.Count; products = @(); categories = @(); groups = @(); hashes = @(); indexItems = @() }
    if ($Job.kind -eq 'GROUPS') {
        $counts = @{}
        $query = New-OneCQuery 'ВЫБРАТЬ Н.Родитель КАК Ref, Н.Родитель.Код КАК Code, КОЛИЧЕСТВО(*) КАК Qty ИЗ Справочник.Номенклатура КАК Н ГДЕ НЕ Н.ЭтоГруппа И НЕ Н.ПометкаУдаления И Н.Родитель.Код >= &FirstCode И Н.Родитель.Код <= &LastCode СГРУППИРОВАТЬ ПО Н.Родитель, Н.Родитель.Код' $range
        $selection = Select-OneCQuery $query
        while (Move-OneCSelection $selection) {
            $countRef = Get-OneCProperty $selection @('Ref')
            $countCode = ([string](Get-OneCProperty $selection @('Code'))).Trim()
            if (-not $countCode) { $countCode = ([string](Get-OneCProperty $countRef @('Код', 'Code') $true)).Trim() }
            $counts[$countCode] = [int](Get-OneCProperty $selection @('Qty'))
        }
        foreach ($row in $rows) {
            $groupKey = if ($row.Code) { $row.Code } else { 'NO_CODE|' + $row.Name.Trim() + '|' + $row.ParentCode }
            $id = Get-StableOneCId 'GROUP' $groupKey
            $parent = if ($row.ParentCode) { Get-StableOneCId 'GROUP' $row.ParentCode } else { '' }
            $body.groups += @{ oneCId = $id; parentId = $parent; name = $row.Name.Trim(); itemCount = [int]$counts[$row.Code] }
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
            $price = [decimal](Get-OneCProperty $selection @('Price'))
            # Real UT 10.3 databases can contain kopecks or several historical
            # representations for the same base price. The site stores whole
            # rubles, so use the maximum selected value and round it safely.
            $price = [decimal]::Round($price, 0, [MidpointRounding]::AwayFromZero)
            if ($price -lt 0) { $price = 0 }
            if ($price -gt [int]::MaxValue) { $price = [int]::MaxValue }
            $priceRef = Get-OneCProperty $selection @('Ref')
            $priceCode = ([string](Get-OneCProperty $selection @('Code'))).Trim()
            if (-not $priceCode) { $priceCode = ([string](Get-OneCProperty $priceRef @('Код', 'Code') $true)).Trim() }
            $map[$priceCode] = [int]$price
        }
        $prices += ,$map
    }
    $stocks = @{}
    $query = New-OneCQuery 'ВЫБРАТЬ О.Номенклатура КАК Ref, О.Номенклатура.Код КАК Code, СУММА(О.КоличествоОстаток) КАК Qty ИЗ РегистрНакопления.ТоварыНаСкладах.Остатки() КАК О ГДЕ О.Номенклатура.Код >= &FirstCode И О.Номенклатура.Код <= &LastCode И О.ХарактеристикаНоменклатуры = ЗНАЧЕНИЕ(Справочник.ХарактеристикиНоменклатуры.ПустаяСсылка) СГРУППИРОВАТЬ ПО О.Номенклатура, О.Номенклатура.Код' $range
    $selection = Select-OneCQuery $query
    while (Move-OneCSelection $selection) {
        $qty = [decimal](Get-OneCProperty $selection @('Qty'))
        # The web mirror exposes sellable whole units. Fractional balances are
        # rounded down instead of aborting the complete catalog transfer.
        $qty = [decimal]::Floor($qty)
        if ($qty -gt [int]::MaxValue) { $qty = [int]::MaxValue }
        $stockRef = Get-OneCProperty $selection @('Ref')
        $stockCode = ([string](Get-OneCProperty $selection @('Code'))).Trim()
        if (-not $stockCode) { $stockCode = ([string](Get-OneCProperty $stockRef @('Код', 'Code') $true)).Trim() }
        $stocks[$stockCode] = [int][Math]::Max(0, $qty)
    }
    $categories = @{}
    foreach ($row in $rows) {
        $identityKey = Get-NomenclatureKey $row.Code $row.Article $row.Name $row.FullName $row.ParentCode
        $id = Get-StableOneCId 'NOMENCLATURE' $identityKey
        $categoryId = if ($row.ParentCode) { Get-StableOneCId 'GROUP' $row.ParentCode } else { Get-StableOneCId 'GROUP' '__ROOT__' }
        $path = Get-GroupPath $row.Parent
        $brand = 'Другие'
        if ($row.Name -match '(?i)iphone|apple') { $brand = 'Apple' }
        elseif ($row.Name -match '(?i)samsung') { $brand = 'Samsung' }
        elseif ($row.Name -match '(?i)xiaomi|redmi|poco') { $brand = 'Xiaomi' }
        elseif ($row.Name -match '(?i)honor') { $brand = 'Honor' }
        elseif ($row.Name -match '(?i)huawei') { $brand = 'Huawei' }
        $product = [ordered]@{ oneCId = $id; sku = '1C-' + $id; slug = '1c-' + $id; name = $row.Name.Trim(); brand = $brand; categoryOneCId = $categoryId; price = [int]$prices[0][$row.Code]; costPrice = $prices[1][$row.Code]; stockQty = [int]$stocks[$row.Code]; isDeleted = $row.Deleted; sourceCode = $row.Code; sourceArticle = $row.Article; sourceFullName = $row.FullName; sourceKind = $row.ItemKind; sourceUnit = $row.UnitName }
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
