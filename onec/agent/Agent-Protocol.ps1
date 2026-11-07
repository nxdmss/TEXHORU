# Shared by the runner and protocol checks. Windows PowerShell 5.1 compatible.
function Read-AgentResult([string]$Text) {
    try { $value = $Text | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'Обработка EPF устарела или вернула неверный результат. Собери EPF из нового модуля TEXHORU.' }
    if ($value.protocolVersion -ne 2 -or $value.ok -isnot [bool]) { throw 'Нужен протокол EPF версии 2.' }
    foreach ($name in @('applied', 'failed', 'processed', 'batches')) {
        $number = $value.$name
        if (($number -isnot [int] -and $number -isnot [long]) -or $number -lt 0 -or $number -gt 30) {
            throw ('Неверный счётчик EPF: ' + $name)
        }
    }
    if ($value.batches -gt 3 -or $value.processed -ne ($value.applied + $value.failed) -or $value.processed -gt ($value.batches * 10) -or
        ($value.ok -and ($value.failed -gt 0 -or $value.error))) { throw 'Противоречивый результат EPF.' }
    return $value
}
