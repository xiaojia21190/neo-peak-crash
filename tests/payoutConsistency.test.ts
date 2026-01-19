import { calculateMultiplier as frontendCalc } from '../app/constants';
import { calculateMultiplier as backendCalc } from '../lib/game-engine/utils';

console.log('测试前后端赔率一致性：');
console.log('');

const testCases: Array<[number, number, number]> = [
  [6.5, 6.5, 0],
  [0, 6.5, 0],
  [13, 6.5, 0],
  [7, 6.2, 3.7],
  [2, 9.1, 10],
];

let allMatch = true;
for (const [targetRow, refRow, timeDelta] of testCases) {
  const frontend = frontendCalc(targetRow, refRow, timeDelta);
  const backend = backendCalc(targetRow, refRow, timeDelta);
  const match = frontend === backend;
  allMatch = allMatch && match;
  console.log(`测试 [targetRow=${targetRow}, refRow=${refRow}, timeDelta=${timeDelta}]`);
  console.log(`  前端: ${frontend}`);
  console.log(`  后端: ${backend}`);
  console.log(`  一致: ${match ? '✅' : '❌'}`);
  console.log('');
}

console.log(`总体结果: ${allMatch ? '✅ 所有测试通过' : '❌ 存在不一致'}`);
process.exit(allMatch ? 0 : 1);
