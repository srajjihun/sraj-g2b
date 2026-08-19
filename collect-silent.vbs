' ── 나라장터 입찰 레이더: 무음 실행 래퍼 ──
' collect.bat 을 창 없이(백그라운드) 실행한다.
' 작업 스케줄러에는 이 파일을 등록하면 검은 창이 전혀 뜨지 않는다.
'   프로그램/스크립트: wscript.exe
'   인수 추가:        "C:\경로\sraj-g2b\collect-silent.vbs"

Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

' 이 vbs 파일이 있는 폴더 = 저장소 폴더
repoDir = fso.GetParentFolderName(WScript.ScriptFullName)
batPath = fso.BuildPath(repoDir, "collect.bat")

' 0 = 창 숨김, False = 종료를 기다리지 않음
shell.Run """" & batPath & """", 0, False
