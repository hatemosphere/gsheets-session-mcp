import { cellEditCommand } from './lib/encode.mjs';

// Expected inner strings from the captured HELLO (H4) and 12345 (H5) edits.
const gid = '0';
const expectHello = '[["0",3,4,7,8],[132274236,3,[2,"HELLO"],null,null,0],[null,[[null,513,[0],null,null,null,null,null,null,null,null,0]]]]';
const expectNum   = '[["0",4,5,7,8],[132274236,3,[3,null,12345],null,null,0],[null,[[null,513,[0],null,null,null,null,null,null,null,null,0]]]]';

const gotHello = cellEditCommand(gid, 'H4', 'HELLO')[1];
const gotNum   = cellEditCommand(gid, 'H5', 12345)[1];

let ok = true;
for (const [name, got, exp] of [['string', gotHello, expectHello], ['number', gotNum, expectNum]]) {
  const pass = got === exp;
  ok &&= pass;
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}`);
  if (!pass) { console.log('  got:', got); console.log('  exp:', exp); }
}
process.exit(ok ? 0 : 1);
