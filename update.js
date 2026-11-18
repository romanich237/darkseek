const { execFileSync } = require('node:child_process');

function git(...args) {
  return execFileSync('git', args, {
    cwd: __dirname,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  }).trim();
}

try {
  const branch = git('symbolic-ref', '--short', 'HEAD');
  const remote = git('config', '--get', `branch.${branch}.remote`);
  const upstreamRef = git('config', '--get', `branch.${branch}.merge`);
  if (!remote || remote === '.' || !upstreamRef.startsWith('refs/heads/')) {
    throw new Error('Настройте отслеживание ветки GitHub через git branch --set-upstream-to=origin/main.');
  }
  git('fetch', '--prune', remote);
  const upstream = git('rev-parse', '--abbrev-ref', '@{upstream}');
  const [ahead, behind] = git('rev-list', '--left-right', '--count', `HEAD...${upstream}`).split(/\s+/).map(Number);
  if (!behind) {
    console.log(ahead ? 'Новых обновлений нет. Есть локальные коммиты.' : 'Установлена последняя версия.');
  } else if (ahead) {
    throw new Error('Ветки разошлись. Объедините изменения вручную.');
  } else {
    console.log(`Доступно обновлений: ${behind}`);
    console.log(git('log', '--oneline', `HEAD..${upstream}`));
    if (process.argv.includes('--apply')) {
      if (git('status', '--porcelain')) throw new Error('Сначала сохраните локальные изменения в Git.');
      git('merge', '--ff-only', upstream);
      console.log('Обновления установлены. Перезапустите DarkSeek.');
    } else {
      console.log('Для установки запустите update.bat или npm run update.');
    }
  }
} catch (error) {
  console.error(error.stderr?.toString().trim() || error.message);
  process.exitCode = 1;
}
