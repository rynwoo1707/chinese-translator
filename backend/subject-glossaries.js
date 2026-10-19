// The subjects a student can choose in the study workspace, each with the built-in terms both translation paths add to
// a request: TEXTBOOK_GLOSSARY for every subject, then the subject's own. Only terms found in the text being translated
// reach the prompt (relevantGlossary), so a longer list costs no token on text that does not use it.
import {MATH_GLOSSARY,TEXTBOOK_GLOSSARY,missingGlossaryTerms} from './ai.js';

// One term per line: simplified Chinese|traditional or Taiwan forms=Vietnamese of the upper-secondary textbooks
// (Chương trình GDPT 2018: gene, allele, acid, ethanol, độ dịch chuyển…). Every key is a whole term of two characters
// or more, because a key matches anywhere inside the text; the single characters kept (酶, 栈) mean nothing else.
// A short key that is also part of other terms (质量, 密度, 速度) has its compounds listed too (质量数 = số khối,
// 电荷密度 = mật độ điện tích): termsInText then counts the compound, not the short key inside it.
// 定理 keeps the spelling of TEXTBOOK_GLOSSARY (định lý) so one translation never mixes two spellings of it.
function terms(text){
 const glossary={},lines=text.trim().split('\n');
 for(const line of lines){
  const [zh,vi]=line.split('=').map(part=>part?.trim());if(!zh||!vi)throw new Error(`Thuật ngữ sai dạng: ${line}`);
  for(const key of zh.split('|')){if(Object.hasOwn(glossary,key)&&glossary[key]!==vi)throw new Error(`Thuật ngữ trùng: ${key}`);glossary[key]=vi.normalize('NFC');}
 }
 return {glossary:Object.freeze(glossary),terms:lines.length};
}

const PHYSICS=terms(`
质点|質點=chất điểm
参考系|參考系|參考座標系=hệ quy chiếu
位移=độ dịch chuyển
速度=vận tốc
速率=tốc độ
平均速度=vận tốc trung bình
瞬时速度|瞬時速度=vận tốc tức thời
加速度=gia tốc
匀速直线运动|勻速直線運動|等速直線運動=chuyển động thẳng đều
匀变速直线运动|勻變速直線運動|等加速度直線運動=chuyển động thẳng biến đổi đều
自由落体|自由落體=rơi tự do
重力加速度=gia tốc rơi tự do
平抛运动|平拋運動|水平拋射=chuyển động ném ngang
斜抛运动|斜拋運動|斜向拋射=chuyển động ném xiên
匀速圆周运动|勻速圓周運動|等速圓周運動=chuyển động tròn đều
圆周运动|圓周運動=chuyển động tròn
角速度=tốc độ góc
线速度|線速度=tốc độ dài
向心加速度=gia tốc hướng tâm
向心力=lực hướng tâm
周期|週期=chu kì
频率|頻率=tần số
合力=hợp lực
分力=lực thành phần
重力=trọng lực
弹力|彈力=lực đàn hồi
摩擦力=lực ma sát
静摩擦力|靜摩擦力=lực ma sát nghỉ
滑动摩擦力|滑動摩擦力|動摩擦力=lực ma sát trượt
动摩擦因数|動摩擦因數|動摩擦係數=hệ số ma sát trượt
劲度系数|勁度係數|彈力常數=độ cứng
胡克定律|虎克定律=định luật Hooke
浮力=lực đẩy Archimedes
质量|質量=khối lượng
密度=khối lượng riêng
电荷密度|電荷密度=mật độ điện tích
电流密度|電流密度=mật độ dòng điện
能量密度=mật độ năng lượng
数密度|數密度=mật độ
压强|壓強=áp suất
惯性|慣性=quán tính
牛顿第一定律|牛頓第一定律|牛頓第一運動定律=định luật 1 Newton
牛顿第二定律|牛頓第二定律|牛頓第二運動定律=định luật 2 Newton
牛顿第三定律|牛頓第三定律|牛頓第三運動定律=định luật 3 Newton
万有引力定律|萬有引力定律=định luật vạn vật hấp dẫn
万有引力|萬有引力=lực hấp dẫn
动量守恒定律|動量守恆定律=định luật bảo toàn động lượng
动量|動量=động lượng
冲量|衝量=xung lượng
功率=công suất
动能定理|動能定理|功能定理=định lý động năng
动能|動能=động năng
重力势能|重力勢能|重力位能=thế năng trọng trường
弹性势能|彈性勢能|彈力位能=thế năng đàn hồi
势能|勢能|位能=thế năng
机械能守恒定律|機械能守恆定律|力學能守恆定律=định luật bảo toàn cơ năng
机械能|機械能|力學能=cơ năng
能量守恒定律|能量守恆定律=định luật bảo toàn năng lượng
简谐运动|簡諧運動|简谐振动|簡諧振動=dao động điều hòa
机械振动|機械振動=dao động cơ
振幅=biên độ
相位=pha
初相位|初相=pha ban đầu
阻尼振动|阻尼振動=dao động tắt dần
受迫振动|受迫振動|強迫振動=dao động cưỡng bức
单摆|單擺=con lắc đơn
弹簧振子|彈簧振子=con lắc lò xo
机械波|機械波|力學波=sóng cơ
横波|橫波=sóng ngang
纵波|縱波=sóng dọc
波长|波長=bước sóng
波速=tốc độ truyền sóng
干涉=giao thoa
衍射|繞射=nhiễu xạ
驻波|駐波=sóng dừng
电磁波|電磁波=sóng điện từ
点电荷|點電荷=điện tích điểm
电荷|電荷=điện tích
库仑定律|庫侖定律=định luật Coulomb
电场强度|電場強度=cường độ điện trường
电场线|電場線|電力線=đường sức điện
电场|電場=điện trường
电势差|電勢差|電位差=hiệu điện thế
电势能|電勢能|電位能=thế năng điện
电势|電勢|電位=điện thế
电压|電壓=hiệu điện thế
电容器|電容器=tụ điện
电容|電容=điện dung
电流|電流=dòng điện
电阻率|電阻率=điện trở suất
电阻|電阻=điện trở
欧姆定律|歐姆定律=định luật Ohm
电动势|電動勢=suất điện động
内阻|內阻|內電阻=điện trở trong
串联|串聯=mắc nối tiếp
并联|並聯=mắc song song
磁场|磁場=từ trường
磁感应强度|磁感應強度=cảm ứng từ
磁感线|磁感線|磁力線=đường sức từ
磁通量=từ thông
安培力=lực từ
洛伦兹力|洛倫茲力|勞倫茲力=lực Lorentz
电磁感应|電磁感應=cảm ứng điện từ
感应电流|感應電流=dòng điện cảm ứng
感应电动势|感應電動勢=suất điện động cảm ứng
楞次定律|冷次定律=định luật Lenz
自感=tự cảm
交变电流|交變電流|交流电|交流電=dòng điện xoay chiều
变压器|變壓器=máy biến áp
折射率=chiết suất
全反射=phản xạ toàn phần
凸透镜|凸透鏡=thấu kính hội tụ
凹透镜|凹透鏡=thấu kính phân kì
焦距=tiêu cự
内能|內能=nội năng
热量|熱量=nhiệt lượng
比热容|比熱容|比熱=nhiệt dung riêng
理想气体|理想氣體=khí lí tưởng
光电效应|光電效應=hiệu ứng quang điện
光子=photon
半衰期=chu kì bán rã
质量数|質量數=số khối
质量亏损|質量虧損=độ hụt khối
比结合能|比結合能=năng lượng liên kết riêng
结合能|結合能=năng lượng liên kết
核裂变|核裂變|核分裂=phản ứng phân hạch
核聚变|核聚變|核融合=phản ứng nhiệt hạch
`);

const CHEMISTRY=terms(`
原子序数|原子序數|原子序=số hiệu nguyên tử
质量数|質量數=số khối
相对原子质量|相對原子質量|原子量=nguyên tử khối
相对分子质量|相對分子質量|分子量=phân tử khối
原子核=hạt nhân nguyên tử
质子|質子=proton
中子=neutron
电子|電子=electron
同位素=đồng vị
元素=nguyên tố
原子=nguyên tử
分子=phân tử
阳离子|陽離子=cation
阴离子|陰離子=anion
离子|離子=ion
电子排布式|電子排布式|電子組態=cấu hình electron
电子层|電子層|能层|能層=lớp electron
能级|能級=phân lớp electron
原子轨道|原子軌道|軌域=orbital nguyên tử
元素周期表|元素週期表|週期表=bảng tuần hoàn các nguyên tố hóa học
元素周期律|元素週期律|週期律=định luật tuần hoàn
周期|週期=chu kì
主族=nhóm A
副族=nhóm B
电负性|電負性|電負度=độ âm điện
化合价|化合價=hóa trị
氧化数|氧化數=số oxi hóa
化学键|化學鍵=liên kết hóa học
离子键|離子鍵=liên kết ion
共价键|共價鍵=liên kết cộng hóa trị
极性键|極性鍵|极性共价键|極性共價鍵=liên kết cộng hóa trị phân cực
非极性键|非極性鍵|非极性共价键|非極性共價鍵=liên kết cộng hóa trị không phân cực
氢键|氫鍵=liên kết hydrogen
金属键|金屬鍵=liên kết kim loại
范德华力|范德華力|凡得瓦力=tương tác van der Waals
单质|單質=đơn chất
化合物=hợp chất
混合物=hỗn hợp
纯净物|純淨物|純物質=chất tinh khiết
化学反应|化學反應=phản ứng hóa học
化学方程式|化學方程式|化學反應式=phương trình hóa học
质量守恒定律|質量守恆定律=định luật bảo toàn khối lượng
氧化还原反应|氧化還原反應=phản ứng oxi hóa – khử
氧化剂|氧化劑=chất oxi hóa
还原剂|還原劑=chất khử
化学反应速率|化學反應速率|反应速率|反應速率=tốc độ phản ứng
催化剂|催化劑=chất xúc tác
活化能=năng lượng hoạt hóa
焓变|焓變=biến thiên enthalpy
放热反应|放熱反應=phản ứng tỏa nhiệt
吸热反应|吸熱反應=phản ứng thu nhiệt
化学平衡|化學平衡=cân bằng hóa học
可逆反应|可逆反應=phản ứng thuận nghịch
平衡常数|平衡常數=hằng số cân bằng
物质的量浓度|物質的量濃度|莫耳濃度=nồng độ mol
物质的量|物質的量=lượng chất
摩尔质量|摩爾質量|莫耳質量=khối lượng mol
气体摩尔体积|氣體摩爾體積=thể tích mol của chất khí
摩尔|摩爾|莫耳=mol
阿伏加德罗常数|阿伏加德羅常數|亞佛加厥常數|亞佛加厥數=hằng số Avogadro
溶液=dung dịch
溶质|溶質=chất tan
溶剂|溶劑=dung môi
溶解度=độ tan
饱和溶液|飽和溶液=dung dịch bão hòa
质量分数|質量分數=phần trăm khối lượng
电解质|電解質=chất điện li
强电解质|強電解質=chất điện li mạnh
弱电解质|弱電解質=chất điện li yếu
电离|電離|解離=điện li
中和反应|中和反應=phản ứng trung hòa
酸性=tính acid
碱性|鹼性=tính base
两性|兩性=lưỡng tính
指示剂|指示劑=chất chỉ thị
沉淀|沉澱=kết tủa
氧化物=oxide
氢氧化物|氫氧化物=hydroxide
有机化合物|有機化合物|有机物|有機物=hợp chất hữu cơ
无机化合物|無機化合物|无机物|無機物=hợp chất vô cơ
烷烃|烷烴|烷類=alkane
烯烃|烯烴|烯類=alkene
炔烃|炔烴|炔類=alkyne
芳香烃|芳香烴=arene
卤代烃|鹵代烴=dẫn xuất halogen
官能团|官能團|官能基=nhóm chức
同分异构体|同分異構體|同分異構物=đồng phân
同系物=chất đồng đẳng
取代反应|取代反應=phản ứng thế
加成反应|加成反應=phản ứng cộng
消去反应|消去反應=phản ứng tách
聚合反应|聚合反應=phản ứng trùng hợp
酯化反应|酯化反應=phản ứng ester hóa
羧酸=carboxylic acid
甲烷=methane
乙烯=ethylene
乙炔=acetylene
乙醇=ethanol
乙酸=acetic acid
苯酚=phenol
葡萄糖=glucose
淀粉|澱粉=tinh bột
纤维素|纖維素=cellulose
油脂=chất béo
原电池|原電池|化學電池=pin điện hóa
电解池|電解池|電解槽=bình điện phân
电解|電解=điện phân
电极|電極=điện cực
阳极|陽極=anode
阴极|陰極=cathode
正极|正極=cực dương
负极|負極=cực âm
标准电极电势|標準電極電勢|標準電極電位=thế điện cực chuẩn
金属活动性顺序|金屬活動性順序=dãy hoạt động hóa học của kim loại
`);

const BIOLOGY=terms(`
细胞膜|細胞膜=màng tế bào
细胞质|細胞質=tế bào chất
细胞核|細胞核=nhân tế bào
细胞壁|細胞壁=thành tế bào
细胞器|細胞器|胞器=bào quan
细胞骨架|細胞骨架=khung xương tế bào
细胞周期|細胞週期=chu kì tế bào
细胞分化|細胞分化=biệt hóa tế bào
细胞凋亡|細胞凋亡=chết tế bào theo chương trình
细胞呼吸|細胞呼吸=hô hấp tế bào
细胞|細胞=tế bào
原核细胞|原核細胞=tế bào nhân sơ
真核细胞|真核細胞=tế bào nhân thực
原核生物=sinh vật nhân sơ
真核生物=sinh vật nhân thực
线粒体|線粒體|粒線體=ti thể
叶绿体|葉綠體=lục lạp
叶绿素|葉綠素=diệp lục
核糖体|核糖體=ribosome
内质网|內質網=lưới nội chất
高尔基体|高爾基體|高基氏體=bộ máy Golgi
溶酶体|溶酶體|溶體=lysosome
液泡=không bào
中心体|中心體=trung thể
有丝分裂|有絲分裂=nguyên phân
减数分裂|減數分裂=giảm phân
光合作用=quang hợp
光反应|光反應=pha sáng
暗反应|暗反應=pha tối
卡尔文循环|卡爾文循環=chu trình Calvin
有氧呼吸=hô hấp hiếu khí
无氧呼吸|無氧呼吸=hô hấp kị khí
发酵|發酵=lên men
酶|酵素=enzyme
蒸腾作用|蒸騰作用=thoát hơi nước
气孔|氣孔=khí khổng
渗透|滲透=thẩm thấu
扩散|擴散=khuếch tán
主动运输|主動運輸=vận chuyển chủ động
被动运输|被動運輸=vận chuyển thụ động
胞吞=nhập bào
胞吐=xuất bào
蛋白质|蛋白質=protein
氨基酸|胺基酸=amino acid
核酸=nucleic acid
糖类|糖類|醣類=carbohydrate
脂质|脂質=lipid
葡萄糖=glucose
新陈代谢|新陳代謝=trao đổi chất
遗传|遺傳=di truyền
变异|變異=biến dị
基因型=kiểu gene
基因突变|基因突變=đột biến gene
等位基因|對偶基因=allele
基因=gene
染色体变异|染色體變異=đột biến nhiễm sắc thể
同源染色体|同源染色體=nhiễm sắc thể tương đồng
性染色体|性染色體=nhiễm sắc thể giới tính
常染色体|常染色體|體染色體=nhiễm sắc thể thường
染色体|染色體=nhiễm sắc thể
表现型|表現型|表型=kiểu hình
显性|顯性=trội
隐性|隱性=lặn
纯合子|純合子=thể đồng hợp
杂合子|雜合子=thể dị hợp
伴性遗传|伴性遺傳|性聯遺傳=di truyền liên kết với giới tính
分离定律|分離定律=quy luật phân li
自由组合定律|自由組合定律|獨立分配律=quy luật phân li độc lập
转录|轉錄=phiên mã
转译|轉譯=dịch mã
密码子|密碼子=codon
反密码子|反密碼子=anticodon
DNA复制|DNA複製=nhân đôi DNA
内环境稳态|內環境穩態|恆定性=cân bằng nội môi
内环境|內環境=môi trường trong
神经元|神經元=neuron
反射弧=cung phản xạ
突触|突觸=synapse
激素|荷爾蒙=hormone
免疫=miễn dịch
抗原=kháng nguyên
抗体|抗體=kháng thể
病毒=virus
细菌|細菌=vi khuẩn
真菌=nấm
原生生物=nguyên sinh vật
受精卵=hợp tử
受精=thụ tinh
配子=giao tử
无性生殖|無性生殖=sinh sản vô tính
有性生殖=sinh sản hữu tính
进化|進化|演化=tiến hóa
自然选择|自然選擇|天擇=chọn lọc tự nhiên
物种|物種=loài
种群|種群|族群=quần thể
群落|群集=quần xã
生态系统|生態系統|生態系=hệ sinh thái
生物圈=sinh quyển
食物链|食物鏈=chuỗi thức ăn
食物网|食物網=lưới thức ăn
生产者|生產者=sinh vật sản xuất
消费者|消費者=sinh vật tiêu thụ
分解者=sinh vật phân giải
能量流动|能量流動=dòng năng lượng
物质循环|物質循環=chu trình sinh địa hóa
显微镜|顯微鏡=kính hiển vi
`);

const INFORMATICS=terms(`
算法|演算法=thuật toán
数据结构|數據結構|資料結構=cấu trúc dữ liệu
程序设计语言|程序設計語言|编程语言|編程語言|程式語言|程式設計語言=ngôn ngữ lập trình
程序设计|程序設計|程式設計=lập trình
编程|編程=lập trình
程序|程式=chương trình
源代码|源代碼|原始碼=mã nguồn
伪代码|偽代碼|虛擬碼=mã giả
流程图|流程圖=sơ đồ khối
变量|變量|變數=biến
常量=hằng
数据类型|數據類型|資料型態|資料型別=kiểu dữ liệu
整型=kiểu số nguyên
浮点数|浮點數=số thực
字符串|字串=xâu kí tự
字符|字元=kí tự
数组|數組|陣列=mảng
列表|串列=danh sách
赋值语句|賦值語句=câu lệnh gán
赋值|賦值=gán
条件语句|條件語句=câu lệnh điều kiện
分支结构|分支結構=cấu trúc rẽ nhánh
循环结构|循環結構|重複結構=cấu trúc lặp
循环|循環|迴圈=vòng lặp
语句|語句=câu lệnh
表达式|表達式|運算式=biểu thức
运算符|運算符|運算子=toán tử
逻辑运算|邏輯運算=phép toán logic
函数|函數|函式=hàm
参数|參數=tham số
返回值|回傳值=giá trị trả về
递归|遞迴|遞歸=đệ quy
迭代=lặp
排序=sắp xếp
冒泡排序|氣泡排序=sắp xếp nổi bọt
选择排序|選擇排序=sắp xếp chọn
插入排序=sắp xếp chèn
顺序查找|順序查找|循序搜尋=tìm kiếm tuần tự
二分查找|二分搜尋=tìm kiếm nhị phân
查找|搜尋=tìm kiếm
时间复杂度|時間複雜度=độ phức tạp thời gian
栈|堆疊=ngăn xếp
队列|隊列|佇列=hàng đợi
链表|鏈表|鏈結串列=danh sách liên kết
二叉树|二叉樹|二元樹=cây nhị phân
计算机|電腦=máy tính
硬件|硬體=phần cứng
软件|軟件|軟體=phần mềm
操作系统|操作系統|作業系統=hệ điều hành
中央处理器|中央處理器=bộ xử lí trung tâm
内存|內存|記憶體=bộ nhớ trong
外存=bộ nhớ ngoài
存储器|存儲器=bộ nhớ
输入设备|輸入設備|輸入裝置=thiết bị vào
输出设备|輸出設備|輸出裝置=thiết bị ra
二进制|二進制|二進位=hệ nhị phân
十进制|十進制|十進位=hệ thập phân
十六进制|十六進制|十六進位=hệ thập lục phân
比特|位元=bit
字节|字節|位元組=byte
编码|編碼=mã hóa
解码|解碼=giải mã
信息|資訊=thông tin
数据库|數據庫|資料庫=cơ sở dữ liệu
数据|數據|資料=dữ liệu
计算机网络|計算機網絡|電腦網路=mạng máy tính
互联网|互聯網|網際網路|因特网|因特網=Internet
局域网|局域網|區域網路=mạng cục bộ
广域网|廣域網|廣域網路=mạng diện rộng
网络|網絡|網路=mạng
网页|網頁=trang web
浏览器|瀏覽器=trình duyệt
搜索引擎|搜尋引擎=máy tìm kiếm
域名=tên miền
协议|協議|協定=giao thức
服务器|服務器|伺服器=máy chủ
客户端|客戶端|用戶端=máy khách
云计算|雲計算|雲端運算=điện toán đám mây
人工智能|人工智慧=trí tuệ nhân tạo
机器学习|機器學習=học máy
大数据|大數據|巨量資料=dữ liệu lớn
文件夹|文件夾|資料夾=thư mục
文件|檔案=tệp
计算机病毒|計算機病毒|電腦病毒=virus máy tính
信息安全|資訊安全=an toàn thông tin
防火墙|防火牆=tường lửa
缩进|縮進|縮排=thụt lề
注释|註釋|註解=chú thích
调试|調試|除錯=gỡ lỗi
编译器|編譯器=trình biên dịch
编译|編譯=biên dịch
解释器|解釋器|直譯器=trình thông dịch
面向对象|面向對象|物件導向=hướng đối tượng
对象|對象|物件=đối tượng
模块|模塊|模組=mô-đun
用户|用戶|使用者=người dùng
界面|介面=giao diện
像素=điểm ảnh
分辨率|解析度=độ phân giải
`);

export const PHYSICS_GLOSSARY=PHYSICS.glossary,CHEMISTRY_GLOSSARY=CHEMISTRY.glossary,BIOLOGY_GLOSSARY=BIOLOGY.glossary,INFORMATICS_GLOSSARY=INFORMATICS.glossary;
// label: the subject's name in the workspace, also the genre a student's book gets and the genre text mode sends.
// terms: how many terms the subject adds (a term can have several Chinese forms).
const none={glossary:Object.freeze({}),terms:0};
export const SUBJECTS=Object.freeze([
 {id:'general',label:'Chuyên khảo · Nghiên cứu',...none},
 {id:'math',label:'Toán học · STEM',glossary:MATH_GLOSSARY,terms:Object.keys(MATH_GLOSSARY).length},
 {id:'history',label:'Lịch sử Trung Hoa',...none},
 {id:'physics',label:'Vật lý',...PHYSICS},
 {id:'chemistry',label:'Hóa học',...CHEMISTRY},
 {id:'biology',label:'Sinh học',...BIOLOGY},
 {id:'informatics',label:'Tin học',...INFORMATICS}
].map(subject=>Object.freeze(subject)));
export const SUBJECT_IDS=Object.freeze(SUBJECTS.map(subject=>subject.id));
// id -> label, the shape of the old DOMAINS maps.
export const SUBJECT_LABELS=Object.freeze(Object.fromEntries(SUBJECTS.map(subject=>[subject.id,subject.label])));
export const isSubject=value=>typeof value==='string'&&SUBJECT_IDS.includes(value);
// Anything else (an old client, a typo) is translated as general text.
export const subjectOf=value=>SUBJECTS.find(subject=>subject.id===value)||SUBJECTS[0];
// A book's genre names its subject: the exact label, or Toán học anywhere, the rule ai.js and reader-glossary.js use.
export const subjectForGenre=genre=>SUBJECTS.find(subject=>subject.label===genre)||(String(genre||'').includes('Toán học')?subjectOf('math'):SUBJECTS[0]);
export const builtInGlossary=value=>({...TEXTBOOK_GLOSSARY,...subjectOf(value).glossary});
// The student's own terms: a built-in term sent back with its built-in meaning is not one, and is not checked
// afterwards (built-in renderings may vary with context, as missingGlossaryTerms already allows for math).
export function ownTerms(glossary,value){
 const builtIn=builtInGlossary(value);
 return Object.fromEntries(Object.entries(glossary||{}).filter(([key,item])=>!(Object.hasOwn(builtIn,key)&&builtIn[key]===item)));
}
// ai.js translate() adds the math terms itself for a genre naming Toán học; every other subject's terms travel in the
// glossary text mode hands it.
export const textModeTerms=value=>{const subject=subjectOf(value);return subject.label.includes('Toán học')?{}:subject.glossary;};
// The terms of a glossary that a text uses, the longest one winning where terms nest: a key counts only where it is not
// part of a longer term found at that place (质量 is not in 质量数 = số khối, 速度 not in 加速度, 密度 not in 电荷密度),
// so a short key is never pressed onto a compound. within: every term that can hold a key (the glossary itself by
// default; a subject's built-in terms around a student's own). Keys keep the glossary's order.
export function termsInText(glossary,text,{within=glossary}={}){
 const source=String(text??''),found=key=>typeof key==='string'&&key.length>0&&source.includes(key),spans=new Map();
 const at=key=>{if(!spans.has(key)){const list=[];for(let index=source.indexOf(key);index>=0;index=source.indexOf(key,index+1))list.push(index);spans.set(key,list);}return spans.get(key);};
 const keys=Object.keys(glossary||{}).filter(found),holders=[...new Set([...keys,...Object.keys(within||{})])].filter(found);
 return Object.fromEntries(keys.filter(key=>{
  const longer=holders.filter(other=>other.length>key.length&&other.includes(key));
  return !longer.length||at(key).some(start=>!longer.some(other=>at(other).some(begin=>begin<=start&&start+key.length<=begin+other.length)));
 }).map(key=>[key,glossary[key]]));
}
// Every built-in term of every subject: a student's own term found only inside one of them is a different word there.
const ALL_BUILT_IN=Object.freeze(Object.assign({},TEXTBOOK_GLOSSARY,...SUBJECTS.map(subject=>subject.glossary)));
// The warning translateAndVerify writes for terms not followed, computed on the student's own terms only, each where it
// stands as a term of its own (termsInText).
export const GLOSSARY_WARNING='Thuật ngữ chưa theo bảng tên: ';
export function ownTermWarnings(source,translation,own){const missed=missingGlossaryTerms(source,translation,termsInText(own,source,{within:{...ALL_BUILT_IN,...own}}));return missed.length?[`${GLOSSARY_WARNING}${missed.slice(0,8).join('; ')}`]:[];}
