# OTOKAWA — 音川青果 統合管理アプリ

## デプロイ手順（Vercel）

### 1. GitHubにアップロード
1. github.com でリポジトリ新規作成（名前: `otokawa`）
2. このフォルダの中身を全部アップロード

### 2. Vercelにデプロイ
1. vercel.com にアクセス → GitHubでログイン
2. 「New Project」→ `otokawa` リポジトリを選択
3. フレームワーク: **Vite** を選択
4. 「Deploy」ボタンを押す → 完了！

### 3. Firebase設定（重要）
Firebase Console → Realtime Database → ルール を以下に変更:
```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

### 4. スタッフへの配布
- デプロイ後のURL（例: `otokawa.vercel.app`）をLINEで共有
- スマホで開く → 「ホーム画面に追加」→ インストール完了

## Firebase同期データ
- `products` — 棚割品目
- `eventProducts` — 催事品目  
- `stores` — 店舗情報
- `shipDate` — 出荷日（共通）
- `shipReport` — ケース数・備考（店舗別）
- `centerStock` — センター在庫
- `displayDates` — 陳列日
- `weeklyReports` — 週次報告
- `tickerItems` — LIVEティッカー
- `reportData` — 売上レポート
