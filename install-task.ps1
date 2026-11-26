# ติดตั้งงานรายชั่วโมงแบบ 24/7 บน Windows (Task Scheduler)
#
#   วิธีใช้ (เปิด PowerShell ปกติ ไม่ต้อง Run as Administrator ถ้าไม่ต้องการ HIGHEST):
#     cd C:\Programing\Hi-Cool\quota-alert
#     powershell -ExecutionPolicy Bypass -File .\install-task.ps1
#
#   ลบงาน:
#     Unregister-ScheduledTask -TaskName "QuotaAlertLine" -Confirm:$false
#
# สิ่งที่ตั้งให้:
#   - ทุก 1 ชั่วโมง ไม่มีวันสิ้นสุด
#   - StartWhenAvailable        : เครื่องหลับ/ปิด แล้วเปิดมา -> รันชดเชยทันที
#   - ไม่หยุดเมื่อใช้แบตเตอรี่
#   - IgnoreNew                 : ถ้ารอบก่อนยังไม่จบ ไม่เปิดซ้อน (สคริปต์มี lock อยู่แล้ว)
#   - ExecutionTimeLimit 30 นาที
#   - LogonType S4U             : รันได้แม้ไม่ได้ login (ไม่ต้องเก็บรหัสผ่าน)

param(
  [string]$TaskName = "QuotaAlertLine",
  [string]$Folder   = $PSScriptRoot,
  [int]$IntervalHours = 1
)

$ErrorActionPreference = "Stop"

$wrapper = Join-Path $Folder "run-quota-alert.cmd"
if (-not (Test-Path $wrapper)) {
  throw "ไม่พบ $wrapper — ตรวจว่าไฟล์ .cmd อยู่โฟลเดอร์เดียวกับสคริปต์นี้"
}
if (-not (Test-Path (Join-Path $Folder ".env"))) {
  Write-Warning "ไม่พบ .env ใน $Folder — สคริปต์จะรันได้แต่จะขาด token/LINE"
}

# ลบของเดิม (ถ้ามี) เพื่อให้ค่าที่ตั้งใหม่มีผลจริง
$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "พบงานเดิม — ลบก่อนติดตั้งใหม่..."
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c `"$wrapper`"" -WorkingDirectory $Folder

# เริ่มทันทีแล้ววนทุกชั่วโมงแบบไม่สิ้นสุด (ไม่ระบุ RepetitionDuration = ตลอดไป)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Hours $IntervalHours)

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -MultipleInstances IgnoreNew `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) `
  -RestartCount 3 `
  -RestartInterval (New-TimeSpan -Minutes 5)

$userId  = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $userId -LogonType S4U -RunLevel Highest

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal `
  -Description "quota-alert: แจ้งเตือนโควตาข้อมูล PIN เข้า LINE ทุกชั่วโมง" | Out-Null

Write-Host ""
Write-Host "✅ ติดตั้งงาน '$TaskName' เรียบร้อย (ทุก $IntervalHours ชั่วโมง, ไม่มีวันสิ้นสุด)"
Write-Host ""
Write-Host "ทดสอบสั่งรันทันที :  Start-ScheduledTask -TaskName $TaskName"
Write-Host "ดูสถานะ           :  Get-ScheduledTask -TaskName $TaskName | Get-ScheduledTaskInfo"
Write-Host "ดูประวัติ          :  Get-WinEvent -LogName 'Microsoft-Windows-TaskScheduler/Operational' -MaxEvents 20 | Where-Object Id -in 102,201,111"
Write-Host "ลบงาน             :  Unregister-ScheduledTask -TaskName $TaskName -Confirm:`$false"
Write-Host ""
Write-Host "log ของสคริปต์    : $Folder\quota-alert.log"
