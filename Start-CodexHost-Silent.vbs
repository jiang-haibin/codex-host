Option Explicit

Dim fso, shell, baseDir, cliCmd, wmi, procs, ans, env, userProfile, oldNoProxy, logPath, cmdLine, exitCode

Set fso = CreateObject("Scripting.FileSystemObject")
Set shell = CreateObject("WScript.Shell")

baseDir = fso.GetParentFolderName(WScript.ScriptFullName)
cliCmd = fso.BuildPath(baseDir, "node_modules\.bin\codexhost.cmd")

If Not fso.FileExists(cliCmd) Then
    MsgBox "Cannot find codexhost.cmd at:" & vbCrLf & cliCmd, vbCritical + vbSystemModal, "CodexHost Launcher"
    WScript.Quit 1
End If

' Check existing ChatGPT.exe / codexhost.exe processes
Set wmi = GetObject("winmgmts:\\.\root\cimv2")
Set procs = wmi.ExecQuery("SELECT Name FROM Win32_Process WHERE Name = 'ChatGPT.exe' OR Name = 'codexhost.exe'")
If procs.Count > 0 Then
    ans = MsgBox("Existing Codex Desktop or CodexHost process is running." & vbCrLf & vbCrLf & "Force close existing instances and restart?", vbYesNo + vbQuestion + vbSystemModal, "CodexHost Launcher")
    If ans <> vbYes Then
        WScript.Quit 1
    End If
    shell.Run "taskkill /F /IM ChatGPT.exe", 0, True
    shell.Run "taskkill /F /IM codexhost.exe", 0, True
    WScript.Sleep 1000
End If

' Inject environment variables
Set env = shell.Environment("PROCESS")
userProfile = shell.ExpandEnvironmentStrings("%USERPROFILE%")
env("CODEXHOST_CONSOLE") = "0"
env("CODEXHOST_WORKBUDDY_COMMAND") = "D:\Workbuddy"
env("WORKBUDDY_CONFIG_DIR") = userProfile & "\.workbuddy"
env("CODEXHOST_ANTIGRAVITY_COMMAND") = userProfile & "\.gemini\bin\agy.exe"

oldNoProxy = env("NO_PROXY")
If oldNoProxy <> "" Then
    env("NO_PROXY") = "workbuddy.cn,tencent.com,localhost,127.0.0.1," & oldNoProxy
Else
    env("NO_PROXY") = "workbuddy.cn,tencent.com,localhost,127.0.0.1"
End If
env("no_proxy") = env("NO_PROXY")

shell.CurrentDirectory = baseDir
logPath = fso.BuildPath(shell.ExpandEnvironmentStrings("%TEMP%"), "codexhost-silent-launch.log")

' Run hidden (0) and wait for completion (True) so process tree stays alive without any visible terminal window
cmdLine = "cmd.exe /d /c """"" & cliCmd & """ > """ & logPath & """ 2>&1"""
exitCode = shell.Run(cmdLine, 0, True)

If exitCode <> 0 Then
    Dim errText, ts
    errText = ""
    If fso.FileExists(logPath) Then
        On Error Resume Next
        Set ts = fso.OpenTextFile(logPath, 1)
        If Err.Number = 0 Then
            errText = ts.ReadAll()
            ts.Close
        End If
        On Error GoTo 0
        If Len(errText) > 800 Then
            errText = Right(errText, 800)
        End If
    End If
    MsgBox "CodexHost exited with error code " & exitCode & "." & vbCrLf & vbCrLf & errText, vbCritical + vbSystemModal, "CodexHost Error"
End If

WScript.Quit exitCode
