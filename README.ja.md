# DSH Workflow Dispatch

[English](README.md) | [日本語](README.ja.md)

DSH Workflow Dispatch は、DSH ワークフロー向けのポリシー／ルーティング層です。モデルの役割別選択、同時実行上限、利用可否判定、Free quota 保護、限定的なフォールバックを集約し、認証情報をソースコードへ埋め込まずに運用します。

## リポジトリ構成

- `index.js` — dispatch エントリポイント
- `model-policy.json` — 公開可能なモデル／Provider選択ポリシー。APIキーは含みません
- `model-policy.js` — ポリシー読込・選択処理
- `usage-admission.js` / `free-quota-guard.js` — 利用可否・quota制御
- `artifact-bridge.js` — 境界を限定したartifact連携
- `cordis.patch.yml` — 汎用的な公開用workflow登録patch
- `dsh-sops.ps1` — ローカルDSH profileから資格情報の「環境変数名」だけを読み、ローカルSOPSから対応する値を子プロセスへ一時注入する任意launcher

## 設定

Git管理されるポリシーファイルは公開可能な既定値です。PC固有の状態や認証情報はリポジトリ外に置きます。

ローカルDSH profileでは、例えば次のように資格情報を環境変数名で参照できます。

```yaml
apiKeyEnv: PROVIDER_API_KEY
```

対応する実値はリポジトリへコミットしません。`dsh-sops.ps1` を使う場合も、暗号化されたSOPSファイルを正本とし、値は起動したDSH子プロセスの環境にだけ一時注入します。

helperが使用するSOPSの既定位置は `$HOME` から導出され、必要なら `-SecretFile` で変更できます。復号済みSecret、`.env`、秘密鍵、Provider token、生成state、PC固有profileはコミットしないでください。

## 開発

```powershell
npm install
npm test
```

smoke実行や生成responseにはローカルstate領域を使用してください。これらは `.gitignore` で除外されています。

## Public repository 方針

- `main` と公開feature branchは常に公開可能な状態に保つ
- Secret・PC固有設定は外部から注入する
- 公開設定は汎用的な識別子・exampleのみを使う
- 生成state、log、ローカルprofile、一時responseはsource artifactにしない

このリポジトリは開発中の公開snapshotです。モデル構成やProviderの利用可否は今後変更される場合があります。

## ブランチ運用

このPublic Repositoryでは、ブランチは開発工程の分離にだけ使用します。

- `main` — 安定した公開可能版
- `develop` — 開発中だが公開されてもよい統合ブランチ
- `feature/*` — `develop` から作成する短命な公開可能featureブランチ

ブランチは**セキュリティ境界として使用しません**。Secret、個人情報、PC固有パス、内部専用コードは、このPublic Repositoryのどのブランチにもコミットしません。これらは `.gitignore` 対象のローカルファイル、SOPS等の外部Secret Store、または内部専用コードが必要な場合は別のPrivate Repositoryで管理します。
