// Passwords people pick most often, refused as new passwords (reader-auth.js passwordProblem). Written by hand for Hoa
// Trí and covered by this repository's own licence: no third-party list is bundled. The international entries are the
// strings at the top of every published ranking of leaked passwords; the Vietnamese ones are the same habits in
// Vietnamese (mật khẩu, anh yêu em, học sinh…). Entries are in the form they are compared in: lower case, Vietnamese
// marks removed, without spaces or punctuation (@ read as a, $ as s), so 'Mật khẩu 123' meets 'matkhau123'. Rules in
// reader-auth.js also refuse a character or a group repeated, runs such as 12345678 or abcdefgh, keyboard rows, dates
// such as a birthday, and the email or name of the account, so those need no entry here.
// COMMON_PASSWORDS: whole passwords of 8 characters or more (a few keep their punctuation: they are compared as typed).
export const COMMON_PASSWORDS=new Set([
 '12345678','123456789','1234567890','12345678910','0123456789','9876543210','987654321','11223344','112233445566','123123123','123321123','1234554321',
 '123456123','12341234','147258369','147852369','159753456','159357456','741852963','963852741','123654789','789456123','1472583690','0987654321',
 '1q2w3e4r','1q2w3e4r5t','1q2w3e4r5t6y','1qaz2wsx','1qaz2wsx3edc','1qazxsw2','zaq12wsx','qazwsxedc','qwertyui','qwertyuiop','qwerty123','qwerty12',
 'qwerty1234','asdfghjk','asdfghjkl','zxcvbnm1','zxcvbnm123','1234qwer','qwer1234','asdf1234','zxcv1234','1234abcd','abcd1234','abc12345','abc123456',
 'abc123abc','123456abc','12345abc','a1234567','a12345678','a123456789','aa123456','aa12345678','aaa12345','1234567a','12345678a','123456789a',
 'password','password1','password12','password123','password1234','passw0rd','iloveyou','iloveyou1','iloveyou2','iloveyou123','admin123','admin1234',
 'administrator','welcome1','welcome123','letmein1','sunshine','princess','football','baseball','superman','starwars','whatever','trustno1','michael1',
 'jennifer','computer','internet','master123','monkey123','dragon123','shadow123','charlie1','liverpool','manchester','chelsea1','arsenal1','pokemon1',
 'minecraft','naruto123','doraemon','onepiece','spiderman','batman123','blackpink','bangtan','btsarmy','samsung1','iphone12','facebook1','google123',
 '!@#$%^&*','!qaz2wsx','!qaz@wsx','1q2w3e4r!','p@ssw0rd!',
 'matkhau1','matkhau12','matkhau123','matkhau1234','matkhaucuatoi','matkhaumoi','matkhaumoi1','anhyeuem','emyeuanh','anhyeuem1','anhyeuem123',
 'emyeuanh123','yeuemnhieu','anhyeuemnhieu','emyeuanhnhieu','yeuanhnhieu','toiyeuban','toiyeuem','toiyeuanh','iloveyouvn','vietnam1','vietnam123',
 'vietnamvodich','vietnamoi','hocsinh1','hocsinh123','sinhvien','sinhvien1','giaovien','hoctap123','hanoi123','saigon123','thienthan','congchua',
 'hoangtu123','conmeo123','meocon123','cuncon123','chimcanhcut','bonghong','hoahong123','tieuthu','khongbiet','khongcomatkhau','chaoban123'
]);
// COMMON_WORDS: a word that, with only digits before or after it, makes a password as easy to guess as the word alone
// (password2026, matkhau123, hoatri2026, 2008hocsinh).
export const COMMON_WORDS=new Set([
 'password','passw0rd','pass','matkhau','matma','iloveyou','iloveu','loveyou','love','anhyeuem','emyeuanh','yeuem','yeuanh','yeu','qwerty','qwertyuiop',
 'asdf','asdfgh','zxcvbn','abc','abcd','abcde','abcdef','admin','user','test','guest','welcome','letmein','hello','xinchao','chaoban','dragon','monkey',
 'shadow','master','sunshine','princess','football','baseball','superman','batman','pokemon','naruto','doraemon','minecraft','facebook','google','gmail',
 'zalo','tiktok','youtube','samsung','iphone','hoatri','hoctap','hocsinh','sinhvien','giaovien','student','teacher','school','truonghoc','tiengtrung',
 'tiengviet','tiengtrungquoc','zhongwen','china','vietnam','hanoi','saigon','hochiminh','danang','haiphong','thienthan','congchua','hoangtu','baby',
 'meocon','cuncon','conmeo','hoahong','bonghong'
]);
// Keyboard rows and columns, read either way: a password that is a stretch of one (asdfghjk, 1qaz2wsx, poiuytrewq),
// with or without digits around it, is as easy to guess as a common password.
export const KEYBOARD_RUNS=['1234567890qwertyuiopasdfghjklzxcvbnm','1qaz2wsx3edc4rfv5tgb6yhn7ujm8ik9ol0p','qazwsxedcrfvtgbyhnujmikolp','zaq1xsw2cde3vfr4bgt5nhy6mju7','1q2w3e4r5t6y7u8i9o0p','q1w2e3r4t5y6u7i8o9p0'];
