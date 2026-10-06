' Starts the Budget Planner server without a visible window.
' Used by the Windows auto-start task; you can also double-click it yourself.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
logFile = appDir & "\data\server.log"
' Keep the log small: past 5 MB it becomes server.log.1 (replacing the older one).
If fso.FileExists(logFile) Then
  If fso.GetFile(logFile).Size > 5 * 1024 * 1024 Then
    If fso.FileExists(logFile & ".1") Then fso.DeleteFile logFile & ".1", True
    fso.MoveFile logFile, logFile & ".1"
  End If
End If
shell.CurrentDirectory = appDir
shell.Run "cmd /c node server.js >> """ & logFile & """ 2>&1", 0, False
