# Wiki 內容鏡像

這個資料夾是 GitHub Wiki（<https://github.com/htlin222/mcq-bank/wiki>，
背後是獨立的 `mcq-bank.wiki.git`）的內容鏡像。

Wiki 是**另一個 git repo**，不會隨主 repo 的分支一起推送。要把這裡的更新
同步到線上 wiki：

```bash
git clone https://github.com/htlin222/mcq-bank.wiki.git /tmp/mcq-wiki
cp wiki/*.md /tmp/mcq-wiki/
cd /tmp/mcq-wiki && git add -A && git commit -m "wiki: sync from main repo" && git push origin master
```

> 本次更新（0030–0033 四項新功能：筆記連結建議 / Telegram 出題機器人 /
> 冪等性層 / 教科書引用「選字問 Wintrobe」）在自動化環境無法直接推 wiki.git
> （egress policy 對 wiki repo 回 403），故先落在主 repo 分支，再由具 wiki
> 寫入權限者以上述步驟同步。
