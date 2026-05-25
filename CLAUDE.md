# Smile Shutter — CLAUDE.md

## プロジェクト概要

Webcam映像からリアルタイムで笑顔を検出し、ピークの笑顔フレームを自動シャッターするWebアプリ。
旅館・婚礼会場・居酒屋での商用展開を目指す。

---

## アーキテクチャ

| 層 | 技術 |
|---|---|
| フロントエンド | HTML / CSS / JavaScript (Vanilla) |
| サーバーレス関数 | Vercel Serverless (Node.js 18) |
| 笑顔検出 | Claude Haiku Vision API (`claude-haiku-4-5-20251001`) |
| カメラ入力 | MediaDevices API (`getUserMedia`) |
| 描画 | Canvas API |
| メール送信 | Resend API (実装済み・未設定) |
| 本番 | https://smile-detection-app-gold.vercel.app/ |

---

## ディレクトリ構成

```
smile-detection-app/
├── CLAUDE.md              # このファイル
├── package.json           # 依存: resend ^3.2.0
├── vercel.json            # APIルーティング設定
├── api/
│   ├── analyze.js           # Anthropic APIプロキシ（APIキーをブラウザに渡さない）
│   └── send-email.js        # Resend経由でセッション写真をメール送信
└── public/
    ├── index.html           # メインUI
    ├── style.css            # スタイル
    └── app.js               # 全ロジック（カメラ/検出/UI）
```

---

## 検出パイプライン

```
[250msごと] フレームキャプチャ
       ↓
frameBufferに迏る (BATCH_SIZE=6満たで出発)
       ↓
/api/analyze → Haikuが6枚分を一括評価
       ↓
各フレームの {score, faces, smiling, kanpai, obstructed} を取得
       ↓
scoreHistory[]に追記（最大HISTORY_MAX=20フレーム）
       ↓
tryPeakShutter(): ピーク確定待ちしてシャッター
```

### ピーク確定アルゴリズム (`tryPeakShutter`)

1. `scoreHistory` の末尾 `PEAK_CONFIRM`(=2) フレームを除いた範囲で「複合スコア」最大のフレームを探す
2. 複合スコア = `score + min(smiling人数, 5) × 0.1`
3. 現在の複合スコアのピーク値が `SMILE_THRESHOLD` 未満ならスキップ
4. ピーク以降の全フレームの複合スコアが `peakVal - PEAK_DROP(=0.08)` を下回っていれば「ピーク確定」
5. ピーク時点のフレームでシャッターを切る（現在の映像ではなく履歴フレームを使う）

→ **タイムラグの解決済み**: API応答遅延中に笑顔が変化してもピーク画像を正确に取得できる。

---

## 主要定数一覧 (`app.js`)

| 定数 | デフォルト | 意味 |
|---|---|---|
| `BATCH_SIZE` | 6 | 1回のAPI履行に送るフレーム数 |
| `CAPTURE_INTERVAL` | 250ms | フレームキャプチャ間隔 |
| `SMILE_THRESHOLD` | 0.72 | シャッター作動の複合スコア閾値 |
| `COOLDOWN_MS` | 3000ms | シャッター後の再検出停止時間 |
| `PEAK_CONFIRM` | 2 | ピーク確定に必要な下降フレーム数 |
| `PEAK_DROP` | 0.08 | ピークからの下降とみなす閾値 |
| `HISTORY_MAX` | 20 | scoreHistoryの最大保持フレーム数 |

---

## 実装済み機能

| 機能 | 状態 | 備考 |
|---|---|---|
| ピーク確定シャッター | ✅ 稼働中 | 1人が高精度 |
| 複数人ピーク選択 | ⚠⁠ 調整中 | **詳細は既知の問題参照** |
| 乾杯検知 | ✅ 稼働中 | kanpaiフラグで独立作動 |
| カメラ切替 | ✅ 稼働中 | 複数カメラ対応 |
| 露出補正 | ✅ 稼働中 | EV -2.0〜+2.0 |
| ZIPダウンロード | ✅ 稼働中 | 全ショット+JSONサマリ |
| メール送信 | 🔧 未設定 | Resend環境変数要設定 |

---

## 既知の問題

### ❗ 複数人時の誤作動（最優先課題）

**現象**: 複数人いるとシャッターが頻繁に作動しすぎる

**原因**: `peakMetric = score + smiling × 0.1` をシャッター作動の閾値判定にも使っているため、
複数人いるだけで閾値を簡単に越えてしまう。

**修正方针**: 
- 閾値判定→ 生スコア（score）のみで判定 (`score >= SMILE_THRESHOLD`)
- ピーク選択（複数フレームのどれを使うか）→ 複合スコアで満たした中から選択

**待機中**: CLAUDE.md整備後に対応予定

### メール送信未設定

**必要なVercel環境変数**:

| 変数名 | 内容 |
|---|---|
| `ANTHROPIC_API_KEY` | 検出用 (設定済み) |
| `RESEND_API_KEY` | Resendダッシュボードで取得 |
| `EMAIL_TO` | 送信先アドレス |
| `EMAIL_FROM` | 送信元（未設定時は `onboarding@resend.dev`） |

---

## 今後の課題（優先順）

1. **複数人誤作動の修正** — 閾値判定を生スコアのみに戻す
2. **メール送信の本番化** — Resend環境変数の設定
3. **オフライン対応** — 通信環境不安定な会場向け
4. **商用向けUI** — ブランドロゴ・カスタムデザイン
5. **APIコスト最適化** — リクエスト頻度の制御
