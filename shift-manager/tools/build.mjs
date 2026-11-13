// gas/Shared.gs から gas/Shared.html を作り、プレビュー用の preview/index.html を組み立てる
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const gas = (f) => fs.readFileSync(path.join(root, 'gas', f), 'utf8');
const shared = gas('Shared.gs');
const sharedHtml = '<script>\n// このファイルは Shared.gs から自動生成されています（tools/build.mjs）。直接編集しないでください。\n' + shared + '\n</script>\n';
fs.writeFileSync(path.join(root, 'gas', 'SharedJs.html'), sharedHtml);

const files = { Styles: gas('Styles.html'), SharedJs: sharedHtml, App: gas('App.html') };
let page = gas('Index.html');
const stubs = fs.readFileSync(path.join(root, 'tools', 'preview-stubs.js'), 'utf8');
const server = '<script>\n' + stubs + '\n</script>\n<script>\n' + gas('Code.gs') + '\n</script>\n';
page = page.replace(/<\?!=\s*include\('(\w+)'\);?\s*\?>/g, (_, name) => {
  if (!(name in files)) throw new Error('unknown include ' + name);
  return name === 'App' ? server + files[name] : files[name];
});
page = page.replace(/<\?!=\s*boot\s*\?>/, JSON.stringify({ page: 'facility', facilityId: '' }));
page = page.replace('<base target="_top">', '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">');
if (/<\?/.test(page)) throw new Error('unresolved scriptlet in preview');
fs.mkdirSync(path.join(root, 'preview'), { recursive: true });
fs.writeFileSync(path.join(root, 'preview', 'index.html'), page);
// 公開用（claude.ai のアーティファクト）：html/head/body を外し、タイトルを先頭に置く
const headInner = page.match(/<head>([\s\S]*?)<\/head>/)[1].replace(/<meta[^>]*>\s*/g, '').replace(/<title>[\s\S]*?<\/title>\s*/, '');
const bodyInner = page.match(/<body>([\s\S]*?)<\/body>/)[1];
fs.writeFileSync(path.join(root, 'preview', 'artifact.html'), '<title>こども園シフト管理</title>\n' + headInner + bodyInner);
console.log('built gas/SharedJs.html, preview/index.html, preview/artifact.html', (page.length / 1024).toFixed(0) + 'KB');
