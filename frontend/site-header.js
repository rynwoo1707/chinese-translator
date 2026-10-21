// Header of the static pages (legal pages, 404): a signed-in reader sees their avatar and name, as in the library.
// Signed out, or when /api/me does not answer, the static "Đăng nhập" link stays.
const login=document.querySelector('.site-masthead .header-login');
if(login)fetch('/api/me',{credentials:'same-origin',headers:{Accept:'application/json'}}).then(response=>response.ok?response.json():null).then(me=>{
 if(!me?.authenticated)return;
 const user=me.user||{},name=String(user.name||'').trim()||'Tài khoản',words=name.split(/\s+/u),initials=(words[0][0]+(words.length>1?words.at(-1)[0]:'')).toLocaleUpperCase('vi-VN');
 const link=document.createElement('a'),avatar=document.createElement('span'),label=document.createElement('span');
 link.className='header-account';link.href='/#account';link.title=name;link.setAttribute('aria-label',`Tài khoản của ${name}`);
 avatar.className='header-avatar';label.className='header-account-name';label.textContent=name;
 if(/^https:\/\//u.test(String(user.picture||''))){const image=document.createElement('img');image.src=user.picture;image.alt='';image.width=32;image.height=32;image.referrerPolicy='no-referrer';avatar.append(image);}
 else avatar.textContent=initials;
 link.append(avatar,label);login.replaceWith(link);
}).catch(()=>{});
