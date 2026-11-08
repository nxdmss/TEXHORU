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

# Negative preflight only: a successful check does not prove the container is valid 1C EPF.
# Read a small prefix; never log file contents, keys or passwords.
function Assert-AgentEpf([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw ('Не найден файл обработки EPF: ' + $Path)
    }
    $stream = $null
    $bytes = New-Object byte[] 4096
    $read = 0
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        $length = $stream.Length
        while ($read -lt $bytes.Length) {
            $next = $stream.Read($bytes, $read, $bytes.Length - $read)
            if ($next -eq 0) { break }
            $read += $next
        }
    } catch {
        throw ('Не удалось прочитать EPF. Проверь доступ к файлу и закрой редактор обработки. ' + $_.Exception.Message)
    } finally {
        if ($stream) { $stream.Dispose() }
    }
    if ($length -lt 16) {
        throw 'Файл EPF пустой или обрезан. Сохрани внешнюю обработку в Конфигураторе заново.'
    }
    $encoding = [Text.Encoding]::UTF8
    $offset = 0
    if ($read -ge 2 -and $bytes[0] -eq 255 -and $bytes[1] -eq 254) {
        $encoding = [Text.Encoding]::Unicode; $offset = 2
    } elseif ($read -ge 2 -and $bytes[0] -eq 254 -and $bytes[1] -eq 255) {
        $encoding = [Text.Encoding]::BigEndianUnicode; $offset = 2
    } elseif ($read -ge 3 -and $bytes[0] -eq 239 -and $bytes[1] -eq 187 -and $bytes[2] -eq 191) {
        $offset = 3
    }
    $text = $encoding.GetString($bytes, $offset, $read - $offset)
    $plainText = $text -notmatch '[\x00-\x08\x0B\x0C\x0E-\x1F]'
    $bsl = $text -match '(?im)^\s*(Процедура|Функция|КонецПроцедуры|КонецФункции|Procedure|Function|EndProcedure|EndFunction)\b'
    $header = $text.TrimStart() -match '(?i)^//\s*TEXHORU'
    if ($plainText -and ($bsl -or $header)) {
        throw 'Вместо EPF сохранён текст модуля. Открой внешнюю обработку в Конфигураторе и сохрани файл EPF из окна обработки, а не из редактора текста.'
    }
}
