const MUSIC_URL='/audio/the-weight-of-unspoken-days.mp3';
// Off by default (school/classroom use); a student who turns it on keeps that choice.
const PREFERENCE_KEY='hoaTriMusic';
let audio,playing=false,starting=false,enabled=false;
try{enabled=localStorage.getItem(PREFERENCE_KEY)==='on';}catch{}
function remember(){try{localStorage.setItem(PREFERENCE_KEY,enabled?'on':'off');}catch{}}
const volume=.18;

function player(){
 if(!audio){audio=new Audio(MUSIC_URL);audio.loop=true;audio.preload='auto';audio.volume=volume;audio.addEventListener('play',()=>{playing=true;sync();});audio.addEventListener('pause',()=>{playing=false;sync();});}
 return audio;
}
function sync(){const button=document.querySelector('#music-toggle');if(!button)return;button.setAttribute('aria-pressed',String(enabled));button.textContent=enabled?'Ⅱ Dừng nhạc':'♫ Bật nhạc nền';button.title=enabled&&!playing?'Nhạc sẽ phát sau lần tương tác đầu tiên; bấm để tắt':'Nhạc nền The Weight of Unspoken Days';}
async function startMusic(){if(!enabled||playing||starting)return;starting=true;try{await player().play();}finally{starting=false;sync();}}
export function stopMusic(){enabled=false;remember();audio?.pause();sync();}
// Drawn inside the page footer (a group, not a landmark), never floating over the content.
export function musicMarkup(){return `<div class="background-music" role="group" aria-label="Nhạc nền"><button id="music-toggle" type="button" aria-pressed="${enabled}">${enabled?'Ⅱ Dừng nhạc':'♫ Bật nhạc nền'}</button></div>`;}
export function bindMusic(onError){const button=document.querySelector('#music-toggle');if(!button)return;sync();button.onclick=()=>{if(enabled)stopMusic();else{enabled=true;remember();sync();void startMusic().catch(error=>onError(error.message));}};void startMusic().catch(()=>{});}
function unlock(event){if(event.target.closest?.('#music-toggle')||!document.querySelector('#music-toggle')||!enabled)return;void startMusic().catch(()=>{});}
document.addEventListener('pointerdown',unlock);
document.addEventListener('keydown',unlock);
