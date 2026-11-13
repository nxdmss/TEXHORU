$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\onec\catalog-agent\Read-UT103.ps1')
function Assert-True($Value, [string]$Message) { if (-not $Value) { throw $Message } }
function New-Reference([string]$Id, [string]$Name, $Parent) {
    $ref = [pscustomobject]@{ Id = $Id; Наименование = $Name; Родитель = $Parent; Код = '643' }
    $ref | Add-Member ScriptMethod УникальныйИдентификатор { return $this.Id }
    return $ref
}
$zero = New-Reference '00000000-0000-0000-0000-000000000000' '' $null
$group = New-Reference '11111111-1111-4111-8111-111111111111' 'Телефоны' $zero
$item = New-Reference '22222222-2222-4222-8222-222222222222' 'Apple iPhone 16' $group
$retail = New-Reference '33333333-3333-4333-8333-333333333333' 'Розничная' $zero
$purchase = New-Reference '44444444-4444-4444-8444-444444444444' 'Закупочная' $zero
$script:config = [pscustomobject]@{ RetailPriceName = 'Розничная'; PurchasePriceName = 'Закупочная' }
$script:fixtureDeleted = $false; $script:fixtureCost = 48000; $script:fixtureFraction = $false; $script:fixtureEmpty = $false
$script:priceTypeCalls = 0; $script:queryCount = 0; $script:priceQueries = @()
function Get-OneCRef([string]$Id) { return $zero }
function Get-PriceType([string]$Name) { if ($Name -eq 'Розничная') { return $retail }; return $purchase }
$characteristics = [pscustomobject]@{}
$characteristics | Add-Member ScriptMethod ПустаяСсылка { return $zero }
$script:connection = [pscustomobject]@{ Справочники = [pscustomobject]@{ ХарактеристикиНоменклатуры = $characteristics } }
$script:connection | Add-Member ScriptMethod NewObject {
    param($Type)
    if ($Type -ne 'Массив') { throw 'Unexpected NewObject' }
    $list = [pscustomobject]@{ Values = (New-Object Collections.ArrayList) }
    $list | Add-Member ScriptMethod Добавить { param($Value); [void]$this.Values.Add($Value) }
    return $list
}
function New-OneCQuery([string]$Text, [hashtable]$Parameters) {
    $script:queryCount++
    $rows = @()
    if ($Text -match 'ПЕРВЫЕ 50') {
        if (-not $script:fixtureEmpty) { $rows = @([pscustomobject]@{ Ref = $item; Code = '0000046151'; Article = 'MPN-123'; Name = 'Apple iPhone 16'; FullName = 'Смартфон Apple iPhone 16'; ItemKind = 'Товар'; Unit = (New-Reference '77777777-7777-4777-8777-777777777777' 'шт' $zero); Parent = $group; Deleted = $script:fixtureDeleted }) }
    } elseif ($Text -match 'СрезПоследних') {
        $script:priceQueries += ,@{ Text = $Text; Parameters = $Parameters }
        $price = if ((Get-RefId $Parameters.PriceType) -eq (Get-RefId $retail)) { 50000 } else { $script:fixtureCost }
        if ($null -ne $price) { $rows = @([pscustomobject]@{ Ref = $item; Price = $price; Variants = 1 }) }
    } elseif ($Text -match 'КоличествоОстаток') {
        $qty = if ($script:fixtureFraction) { 1.5 } else { 5 }
        $rows = @([pscustomobject]@{ Ref = $item; Qty = $qty })
    } else { throw 'Unexpected query' }
    $selection = [pscustomobject]@{ Rows = $rows; Index = -1; Ref = $null; Code = ''; Article = ''; Name = ''; FullName = ''; ItemKind = ''; Unit = $null; Parent = $null; Deleted = $false; Price = 0; Variants = 0; Qty = 0 }
    $selection | Add-Member ScriptMethod Следующий {
        $this.Index++
        if ($this.Index -ge $this.Rows.Count) { return $false }
        $r = $this.Rows[$this.Index]
        foreach ($property in $r.PSObject.Properties) { $this.($property.Name) = $property.Value }
        return $true
    }
    $result = [pscustomobject]@{ Selection = $selection }
    $result | Add-Member ScriptMethod Выбрать { return $this.Selection }
    $query = [pscustomobject]@{ Result = $result }
    $query | Add-Member ScriptMethod Выполнить { return $this.Result }
    return $query
}
function Invoke-AgentApi { param($Method, $Path, $Body); return @{ needed = @() } }
$job = [pscustomobject]@{ kind = 'CATALOG'; cursor = ''; groupId = ''; leaseToken = '55555555-5555-4555-8555-555555555555'; nextBatch = 0; mode = 'FULL' }
$full = Read-RemotePage $job
Assert-True ($full -is [hashtable]) 'Page returned stray COM/pipeline output instead of one packet'
Assert-True ($full.products.Count -eq 1 -and $full.categories.Count -eq 1) 'Product/category lost'
Assert-True ($full.products[0].price -eq 50000 -and $full.products[0].costPrice -eq 48000 -and $full.products[0].stockQty -eq 5) 'Price, floor or quantity corrupted'
Assert-True ($full.products[0].mpn -eq 'MPN-123') 'MPN lost'
Assert-True ($full.products[0].sourceCode -eq '0000046151' -and $full.products[0].sourceArticle -eq 'MPN-123' -and $full.products[0].sourceFullName -eq 'Смартфон Apple iPhone 16' -and $full.products[0].sourceKind -eq 'Товар' -and $full.products[0].sourceUnit -eq 'шт') 'Original nomenclature columns lost'
Assert-True ($full.cursor -eq '0000046151') 'Catalog code cursor lost'
Assert-True ($script:queryCount -eq 4) 'Queries are not batched'
Assert-True ($script:priceQueries.Count -eq 2 -and $script:priceQueries[0].Text -match 'СрезПоследних\(, ТипЦен = &PriceType\)' -and -not $script:priceQueries[0].Parameters.ContainsKey('Now')) 'Latest price slice must not pass an incompatible .NET DateTime to legacy UT 10.3'
$json = $full | ConvertTo-Json -Depth 15 -Compress
$parsed = $json | ConvertFrom-Json
Assert-True ($parsed.products -is [array] -and $parsed.hashes -is [array]) 'Single product became scalar JSON'
$again = Read-RemotePage $job
Assert-True ($full.hashes[0].hash -eq $again.hashes[0].hash) 'Hash is unstable'
$job.mode = 'DELTA'
$delta = Read-RemotePage $job
Assert-True ($delta.products.Count -eq 0 -and $delta.scanned -eq 1 -and $delta.hashes.Count -eq 1) 'DELTA must advance the cursor without resending known cards'
$job.mode = 'FULL'; $script:fixtureCost = $null; $script:fixtureDeleted = $true
$missing = Read-RemotePage $job
Assert-True ($null -eq $missing.products[0].costPrice -and $missing.products[0].stockQty -eq 0) 'Missing floor or deleted stock is wrong'
Assert-True (($missing | ConvertTo-Json -Depth 15 -Compress) -match '"costPrice":null') 'Unknown purchase must explicitly clear stale cost'
$script:fixtureFraction = $true; $rejected = $false
try { Read-RemotePage $job | Out-Null } catch { $rejected = $true }
Assert-True $rejected 'Fractional stock must fail instead of rounding'
$script:fixtureEmpty = $true
Assert-True ($null -eq (Read-RemotePage $job)) 'Empty page must finish the job'
Write-Host 'PASS: Windows adapter packet, bounded queries, stable hashes, array JSON, DELTA cursor, purchase null, deletion, fractional stock and EOF'
