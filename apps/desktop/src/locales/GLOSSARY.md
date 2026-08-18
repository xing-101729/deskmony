# 翻譯術語表

現有中文 UI 常把英文技術名詞直接混在中文句子裡(worktree、YOLO、session、profile、
token、checkpoint、adapter、webhook、model、team、task)。翻譯到 en/ja/es 時:

- **預設保留原文(拉丁字母)**,不要為這些字硬翻成目標語言的「本土」說法。
- 例外:該語言的技術寫作本來就有非常標準的外來語慣用形式時可以用(例如日文的
  セッション/トークン 是極常見的片假名寫法)。
- 原則是「對讀那個語言的工程師來說自然、且全專案內同一個詞的處理方式一致」,
  不是逐字翻譯術語。
- 錯誤代碼(`errors:*` namespace)裡的 `entityType` 這類參數值(例如
  "session"/"task"/"agentProfile"/"teamMember")維持英文 lowerCamelCase 原樣
  插入句子中,不要翻譯這些值本身——只翻譯它們周圍的句子結構。

高頻詞(遇到時沿用同一種處理方式,不要每個檔案各自決定):
worktree, YOLO, session, profile, token, checkpoint, adapter, webhook, model,
team, provider, slash command.

**slash command**(2026-08-18 新增):預設保留英文原文,不翻譯——例外是日文,
`スラッシュコマンド` 是該語言技術寫作已經非常標準的外來語慣用形式(同「セッション/
トークン」的既有例外),見 `ja/chat.json` 的 `slashCommands` 區塊。

**修正(見下方時間戳記)**:`task` **不**在上面清單裡——已完成的批次(`recovery.json`/
`chat.json`/`notifications.json`/`errors-tasks.json`/`sessionList.json`/`app.json`
等)一致把它翻譯成 ja「タスク」、es「tarea」,不是保留英文。這份文件原本誤把
`task` 也列進「保留原文」清單,與實際已上線的翻譯不符——已修正移除,請沿用
「翻譯」這個既有慣例,不要保留英文 `task`。

在動手翻譯前先讀這份文件。

---
2026-08-14:上面「修正」段落新增——F-Config 批次完成後發現此落差並回報,主體
直接修正本檔案,避免最後一批(F-Team,大量處理 TaskBoardView.tsx)延續錯誤指引。
