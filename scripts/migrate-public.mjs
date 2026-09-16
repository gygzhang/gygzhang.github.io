import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const posts = [
  ['2023/04/27/CUDA-SGEMM优化笔记/index.html', 'cuda-sgemm', 'CUDA SGEMM 优化笔记', '2023-04-27', ['CUDA', 'Performance']],
  ['2023/04/25/CUDA-prefix-scan优化笔记/index.html', 'cuda-prefix-scan', 'CUDA Prefix Scan 优化笔记', '2023-04-25', ['CUDA', 'Algorithms']],
  ['2023/04/24/CUDA-reduce优化笔记/index.html', 'cuda-reduce', 'CUDA Reduce 优化笔记', '2023-04-24', ['CUDA', 'Performance']],
  ['2022/03/19/xv6网络协议栈实现分析/index.html', 'xv6-network-stack', 'xv6 网络协议栈实现分析', '2022-03-19', ['xv6', 'OS']],
  ['2022/07/27/现代C-基础/index.html', 'modern-cpp', '现代 C++ 基础', '2022-07-27', ['C++']],
];

function htmlToMarkdown(html) {
  return html
    .replace(/<td class="gutter">[\s\S]*?<\/td>/gi, '')
    .replace(/<figure class="highlight[^>]*>[\s\S]*?<td class="code"><pre>/gi, '<pre><code>')
    .replace(/<\/pre><\/td>[\s\S]*?<\/figure>/gi, '</code></pre>')
    .replace(/<img[^>]+src="([^"]+)"[^>]*>/gi, '![]($1)')
    .replace(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/gi, (_, code) => `\n\n\`\`\`\n${code.replace(/<span class="line">/g, '').replace(/<\/span>/g, '').replace(/<br\s*\/?\s*>/gi, '\n').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&#123;/g, '{').replace(/&#125;/g, '}').replace(/&#42;/g, '*')}\n\`\`\`\n\n`)
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<em>([\s\S]*?)<\/em>/gi, '*$1*')
    .replace(/<h([2-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, text) => `\n\n${'#'.repeat(Number(level))} ${text.replace(/<[^>]+>/g, '')}\n\n`)
    .replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, text) => `\n- ${text.replace(/<[^>]+>/g, '')}`)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '$1\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\/\.\.\/imgs\//g, '/imgs/')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&#123;/g, '{')
    .replace(/&#125;/g, '}')
    .replace(/&#42;/g, '*')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

for (const [source, slug, title, date, tags] of posts) {
  const input = fs.readFileSync(path.join(root, source), 'utf8');
  const match = input.match(/<div class="post-body"[^>]*>([\s\S]*?)<\/div>/i);
  if (!match) throw new Error(`正文未找到: ${source}`);
  const markdown = `---\ntitle: ${title}\ndate: ${date}\ntags: [${tags.join(', ')}]\nvisibility: public\n---\n\n${htmlToMarkdown(match[1])}\n`;
  const output = path.join(root, 'src/content/posts', `${slug}.md`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, markdown);
  console.log(`migrated ${slug}`);
}
