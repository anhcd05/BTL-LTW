/** Bounded, explicit selection shared by live smoke and its offline tests. */
function selectFixtures(dataset,args){
  const value=name=>{const i=args.indexOf(name);if(i<0)return undefined;if(!args[i+1]||args[i+1].startsWith('--'))throw Error('INVALID_ARGUMENT');return args[i+1];};
  const evaluate=args.includes('--evaluate'),suite=args.includes('--suite'),split=value('--split');
  if(evaluate&&!['development','test'].includes(split)||!evaluate&&split!==undefined||evaluate&&suite)throw Error('INVALID_SPLIT');
  const corpus=dataset.fixtures.filter(f=>evaluate?f.split===split:f.smoke);
  const ids=[];
  for(let i=0;i<args.length;i++)if(args[i]==='--fixture'){
    if(!args[i+1]||args[i+1].startsWith('--'))throw Error('INVALID_FIXTURE');
    ids.push(...args[++i].split(','));
  }
  if(ids.length!==new Set(ids).size)throw Error('DUPLICATE_FIXTURE');
  if(ids.some(id=>!corpus.some(f=>f.id===id)))throw Error('INVALID_FIXTURE');
  const fixtures=ids.length?ids.map(id=>corpus.find(f=>f.id===id)):evaluate||suite?corpus:corpus.slice(0,1);
  if(!fixtures.length)throw Error('EMPTY_SELECTION');
  return {fixtures,corpusSize:corpus.length,notSelected:corpus.length-fixtures.length,mode:evaluate?'evaluation':'smoke',split:evaluate?split:'development',output:value('--out')};
}
module.exports={selectFixtures};
