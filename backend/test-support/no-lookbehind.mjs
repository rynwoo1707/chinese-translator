// node --import ./backend/test-support/no-lookbehind.mjs: RegExp refuses a lookbehind ((?<=…), (?<!…)) as Safari and iOS
// before 16.4 do, with the same SyntaxError. Regular expression literals are compiled by the engine and do not pass
// through this; old-browsers.test.mjs checks with esbuild that no first-party module has such a literal.
const Native=globalThis.RegExp;
class NoLookbehind extends Native{
 constructor(pattern,flags){
  const source=pattern instanceof Native?pattern.source:String(pattern??'');
  if(/\(\?<[=!]/u.test(source))throw new SyntaxError(`Invalid regular expression: /${source}/: Invalid group specifier name`);
  super(pattern,flags);
 }
 static get [Symbol.species](){return NoLookbehind;}
}
globalThis.RegExp=NoLookbehind;
