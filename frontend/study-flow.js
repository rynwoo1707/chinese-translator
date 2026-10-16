export async function runStudyTranslation({selectionTask,requireKey,needsPreparation,hasSource,hasFile,prepare,translate}){
 await selectionTask;
 requireKey();
 if(needsPreparation()||(!hasSource()&&hasFile())){
  const ready=await prepare();
  if(!ready)return false;
 }
 await translate();
 return true;
}
