const fs=require('node:fs');
const path=require('node:path');
for(const name of ['infosound','comment-moderation']){
  const source='/source/'+name,target='/repo/'+name;
  fs.cpSync(source,target,{recursive:true,filter:file=>{
    const parts=path.relative(source,file).split(path.sep);
    if(parts.some(p=>['node_modules','.git','.next','dist','generated','.runtime-private'].includes(p)))return false;
    const leaf=path.basename(file);
    return !(leaf.startsWith('.env')&&leaf!=='.env.example');
  }});
}
