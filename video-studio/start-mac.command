#!/bin/bash
# AI Video Studio 起動用（Mac）: このファイルをダブルクリック
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js が入っていません。"
  echo "  今からブラウザで Node.js のページを開きます。「LTS」をダウンロードしてインストールし、"
  echo "  終わったら、もう一度この「start-mac.command」をダブルクリックしてください。"
  echo ""
  open "https://nodejs.org/ja/download"
  read -r -p "  Enter キーで閉じます" _
  exit 1
fi

if [ ! -d node_modules ]; then
  echo ""
  echo "  [初回のみ] 必要な部品をインストールしています。数分かかります..."
  echo ""
  if ! npm install; then
    echo "  インストールに失敗しました。インターネット接続を確認して、もう一度ダブルクリックしてください。"
    read -r -p "  Enter キーで閉じます" _
    exit 1
  fi
fi

echo ""
echo "  AI Video Studio を起動します。ブラウザが自動で開きます。"
echo "  使い終わったら、このウィンドウを閉じてください。"
echo ""
node server/index.js
