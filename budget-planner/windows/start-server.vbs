' Starts the Budget Planner server without a visible window.
' Used by the Windows auto-start task; you can also double-click it yourself.
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
appDir = fso.GetParentFolderName(fso.GetParentFolderName(WScript.ScriptFullName))
logFile = appDir & "\data\server.log"
shell.CurrentDirectory = appDir
shell.Run "cmd /c node server.js >> """ & logFile & """ 2>&1", 0, False
