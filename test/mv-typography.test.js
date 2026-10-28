import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTypography, typographyDefaults, wordFontSize } from '../public/mv-typography.js';

test('文字样式可安全恢复，字号范围有序、数值限幅，零透明度和关闭效果可保留', () => {
  assert.deepEqual(normalizeTypography(null), typographyDefaults);
  assert.deepEqual(normalizeTypography({color:'url(x)',opacity:NaN,shadowEnabled:'false'}), typographyDefaults);
  const settings = normalizeTypography({minSize:100,maxSize:20,lineGap:-4,opacity:0,strokeWidth:999,shadowX:-100,shadowEnabled:false});
  assert.equal(settings.minSize,20); assert.equal(settings.maxSize,100);
  assert.equal(settings.lineGap,0); assert.equal(settings.color,'rgba(255, 255, 255, 0)');
  assert.equal(settings.shadowColor,'rgba(0, 0, 0, 0)');
  assert.equal(settings.strokeWidth,6); assert.equal(settings.shadowX,-40);
  assert.equal(settings.shadowEnabled,false);
  assert.deepEqual(normalizeTypography(JSON.parse(JSON.stringify(settings))),settings);
});

test('旧透明度合并进 RGBA，文字、阴影、描边的 alpha 可分别设置且不会重复相乘', () => {
  const old = normalizeTypography({color:'#ffffff',opacity:0.5,shadowColor:'#000000',shadowOpacity:0.6,strokeColor:'#123456'});
  assert.equal(old.color,'rgba(255, 255, 255, 0.5)');
  assert.equal(old.shadowColor,'rgba(0, 0, 0, 0.3)');
  assert.equal(old.strokeColor,'rgba(18, 52, 86, 0.5)');
  assert.ok(!('opacity' in old) && !('shadowOpacity' in old));
  assert.deepEqual(normalizeTypography(old),old);
  const current = normalizeTypography({color:'rgba(1,2,3,0)',shadowColor:'rgba(4,5,6,0.2)',strokeColor:'rgba(7,8,9,0.7)'});
  assert.equal(current.color,'rgba(1, 2, 3, 0)');
  assert.equal(current.shadowColor,'rgba(4, 5, 6, 0.2)');
  assert.equal(current.strokeColor,'rgba(7, 8, 9, 0.7)');
});

test('词语字号落在用户设置的最大最小范围内，统一字号时保留相同大小', () => {
  const settings = normalizeTypography({minSize:24,maxSize:64});
  const sizes = [0.5,0.7568,0.9,1.2,1.38,2].map(weight=>wordFontSize(weight,settings));
  assert.equal(sizes[0],24); assert.equal(sizes.at(-1),64);
  assert.ok(sizes.every(size=>size>=24 && size<=64));
  assert.ok(sizes[2]<sizes[3]);
  assert.equal(wordFontSize(1.2,normalizeTypography({minSize:40,maxSize:40})),40);
});

test('文本偏移保留正负方向，兼容旧配置并限制异常数值，刷新后保持偏移', () => {
  assert.equal(normalizeTypography({}).offsetX, 0);
  assert.equal(normalizeTypography({offsetY:NaN}).offsetY, 0);
  const settings = normalizeTypography({offsetX:120,offsetY:-60});
  assert.equal(settings.offsetX,120); assert.equal(settings.offsetY,-60);
  assert.deepEqual(normalizeTypography(JSON.parse(JSON.stringify(settings))), settings);
  assert.equal(normalizeTypography({offsetX:99999}).offsetX,4000);
  assert.equal(normalizeTypography({offsetY:-99999}).offsetY,-4000);
});
