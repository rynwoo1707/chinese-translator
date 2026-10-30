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
// The switch's icon is drawn (a note; two solid bars while it is on), not a font glyph: the site font has neither, and a
// screen reader would read one aloud. aria-hidden leaves the words as the button's name.
const NOTE='<path d="M9 18V6l11-2v12M9 18a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0M20 16a2.5 2.5 0 1 1-5 0a2.5 2.5 0 1 1 5 0"/>',PAUSE='<path d="M7 5h2.5v14H7zM14.5 5H17v14h-2.5z" fill="currentColor"/>';
function label(){return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${enabled?PAUSE:NOTE}</svg><span>${enabled?'Dừng nhạc':'Bật nhạc nền'}</span>`;}
function sync(){const button=document.querySelector('#music-toggle');if(!button)return;button.setAttribute('aria-pressed',String(enabled));button.innerHTML=label();button.title=enabled&&!playing?'Nhạc sẽ phát sau lần tương tác đầu tiên; bấm để tắt':'Nhạc nền The Weight of Unspoken Days';}
async function startMusic(){if(!enabled||playing||starting)return;starting=true;try{await player().play();}finally{starting=false;sync();}}
export function stopMusic(){enabled=false;remember();audio?.pause();sync();}
// Drawn inside the page footer (a group, not a landmark), never floating over the content.
export function musicMarkup(){return `<div class="background-music" role="group" aria-label="Nhạc nền"><button id="music-toggle" type="button" aria-pressed="${enabled}">${label()}</button></div>`;}
export function bindMusic(onError){const button=document.querySelector('#music-toggle');if(!button)return;sync();button.onclick=()=>{if(enabled)stopMusic();else{enabled=true;remember();sync();void startMusic().catch(error=>onError(error.message));}};void startMusic().catch(()=>{});}
function unlock(event){if(event.target.closest?.('#music-toggle')||!document.querySelector('#music-toggle')||!enabled)return;void startMusic().catch(()=>{});}
document.addEventListener('pointerdown',unlock);
document.addEventListener('keydown',unlock);
