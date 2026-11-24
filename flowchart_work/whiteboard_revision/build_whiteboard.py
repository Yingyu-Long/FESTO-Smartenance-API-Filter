from pathlib import Path
from xml.etree import ElementTree as ET
from xml.dom import minidom
from PIL import Image, ImageDraw, ImageFont
import math, json

BASE=Path('/Users/albertlong/Documents/ChatGPT/FESTO')
BUILD=BASE/'flowchart_work/whiteboard_revision'
OUT=BASE/'output'
W,H=1992,630
BLACK='#343B37'
RED='#B8666C'
GRAY='#A4AAA0'
LINE='#C7CAC2'

mf=ET.Element('mxfile',host='app.diagrams.net',agent='Codex',type='device',compressed='false')
diag=ET.SubElement(mf,'diagram',id='whiteboard-original-layout',name='白板原版布局')
model=ET.SubElement(diag,'mxGraphModel',dx=str(W),dy=str(H),grid='0',gridSize='10',guides='1',tooltips='1',connect='1',arrows='1',fold='1',page='1',pageScale='1',pageWidth=str(W),pageHeight=str(H),math='0',shadow='0',background='#FFFFFF')
root=ET.SubElement(model,'root')
ET.SubElement(root,'mxCell',id='0')
ET.SubElement(root,'mxCell',id='1',parent='0')
visuals=[]
uncertain=[]
used=set(['0','1'])

def txt(id,label,x,y,w,h,size=20,color=BLACK,align='left',bold=False,italic=False,underline=False,note=None,font='Comic Sans MS'):
    assert id not in used;used.add(id)
    style=f'text;html=0;whiteSpace=nowrap;overflow=visible;align={align};verticalAlign=middle;rounded=0;strokeColor=none;fillColor=none;fontFamily={font};fontSize={size};fontColor={color};fontStyle={(1 if bold else 0)+(2 if italic else 0)+(4 if underline else 0)};spacing=0;spacingTop=0;spacingBottom=0;spacingLeft=0;spacingRight=0;'
    if note:
        wrapper=ET.SubElement(root,'object',id=id,label=label,tooltip=note)
        c=ET.SubElement(wrapper,'mxCell',style=style,vertex='1',parent='1')
        uncertain.append({'label':label,'note':note})
    else:
        c=ET.SubElement(root,'mxCell',id=id,value=label,style=style,vertex='1',parent='1')
    ET.SubElement(c,'mxGeometry',x=str(x),y=str(y),width=str(w),height=str(h),attrib={'as':'geometry'})
    visuals.append(dict(type='text',id=id,label=label,x=x,y=y,w=w,h=h,size=size,color=color,align=align,bold=bold,italic=italic,underline=underline,font=font))

def path(id,pts,color=BLACK,width=1.2,arrow=False,dashed=False,curved=False):
    assert id not in used;used.add(id)
    style=f'edgeStyle=none;html=0;rounded=0;curved={1 if curved else 0};endArrow={"open" if arrow else "none"};endSize=8;endFill=0;startArrow=none;strokeColor={color};strokeWidth={width};'
    if dashed:style+='dashed=1;dashPattern=2 7;'
    c=ET.SubElement(root,'mxCell',id=id,value='',style=style,edge='1',parent='1')
    g=ET.SubElement(c,'mxGeometry',relative='1',attrib={'as':'geometry'})
    ET.SubElement(g,'mxPoint',x=str(pts[0][0]),y=str(pts[0][1]),attrib={'as':'sourcePoint'})
    ET.SubElement(g,'mxPoint',x=str(pts[-1][0]),y=str(pts[-1][1]),attrib={'as':'targetPoint'})
    if len(pts)>2:
        a=ET.SubElement(g,'Array',attrib={'as':'points'})
        for x,y in pts[1:-1]:ET.SubElement(a,'mxPoint',x=str(x),y=str(y))
    visuals.append(dict(type='path',id=id,pts=pts,color=color,width=width,arrow=arrow,dashed=dashed))

def arr(id,x1,y1,x2,y2,color=BLACK,width=1.2):
    path(id,[(x1,y1),(x2,y2)],color,width,True)

def underline(id,x1,y1,x2,y2,color=BLACK,width=.9):
    path(id,[(x1,y1),(x2,y2)],color,width)

def brace(id,x,y,h,side='left',color=BLACK,width=1):
    # Editable polyline reproduces the grouping brace without a containing box.
    k=1 if side=='left' else -1
    path(id,[(x+6*k,y),(x+2*k,y+4),(x+2*k,y+h*.38),(x-3*k,y+h*.5),(x+2*k,y+h*.62),(x+2*k,y+h-4),(x+6*k,y+h)],color,width)

def bypass(id,x,y,w=65,h=22):
    path(id+'_shape',[(x,y+h),(x+4,y),(x+w-5,y+1),(x+w-4,y+h)],BLACK,.95)
    arr(id+'_arrow',x+14,y+1,x+35,y+1,width=1)
    path(id+'_dots',[(x+4,y+h),(x+w-3,y+h)],BLACK,1.1,dashed=True)

def circled_number(id,label,x,y,size=25):
    assert id not in used;used.add(id)
    style=f'ellipse;html=0;whiteSpace=nowrap;aspect=fixed;fillColor=none;strokeColor={BLACK};strokeWidth=1.1;fontFamily=Comic Sans MS;fontSize=19;fontColor={BLACK};align=center;verticalAlign=middle;spacing=0;'
    c=ET.SubElement(root,'mxCell',id=id,value=label,style=style,vertex='1',parent='1')
    ET.SubElement(c,'mxGeometry',x=str(x),y=str(y),width=str(size),height=str(size),attrib={'as':'geometry'})
    visuals.append(dict(type='circle',id=id,label=label,x=x,y=y,w=size,h=size,size=19,color=BLACK,bold=False))

# Keep the whiteboard's aspect ratio, positions, open areas and subtle dividers.
path('left_divider',[(303,4),(303,619)],'#71786F',1.3)
path('main_underline',[(311,65),(770,73),(1234,77),(1801,88)],LINE,.8)
path('online_separator',[(313,131),(710,137),(1228,144)],LINE,.6)
path('components_separator',[(310,228),(702,226),(1031,234),(1237,237)],LINE,.7)

# Left classification column.
txt('online','Online',82,79,75,36,26,italic=True)
underline('online_underline',82,118,151,116,GRAY)
brace('online_brace',164,71,60,color=GRAY,width=.9)
txt('app_world','App World',175,65,111,29,19)
txt('fox','FoX',175,101,47,32,23)
txt('xiaolong','(Xiaolong)',215,115,80,21,13,note='原图括号内姓名按 Xiaolong 转写，拼写请确认。')
txt('components','Components',102,170,122,31,21)
txt('components_slash','/',223,170,14,34,28)
txt('sap','SAP',240,170,47,28,20)
txt('cic','CIC.',240,198,47,24,17)
txt('component_sales','Sales.',237,220,56,24,17)
txt('dpc','DPC ?',232,242,61,25,18)
txt('ts_label','TS',125,308,59,45,31)
txt('cs_label','CS',127,414,54,43,28)
txt('old_label','旧',186,430,34,37,28,bold=True,font='Microsoft YaHei')

# Main stages and their original short, separately editable arrows.
txt('phase_opportunity','机会',377,17,67,46,31,font='Microsoft YaHei')
arr('phase_a1',441,41,474,41,GRAY)
txt('phase_requirement','需求',547,13,73,50,34,font='Microsoft YaHei')
arr('phase_a2',632,40,662,40,GRAY)
txt('phase_quote','报价',716,16,75,49,34,font='Microsoft YaHei')
arr('phase_a3',827,42,853,42,GRAY)
txt('phase_order','下单',934,19,69,48,33,font='Microsoft YaHei')
arr('phase_a4',1014,52,1050,52,GRAY)
txt('phase_assembly','装配',1115,19,79,49,33,font='Microsoft YaHei')
arr('phase_a5',1224,50,1254,50,GRAY)
txt('phase_ship','发货',1336,22,76,51,34,font='Microsoft YaHei')
txt('phase_slash','/',1411,28,22,49,36,color=GRAY)
txt('phase_invoice','开票',1438,24,80,52,34,font='Microsoft YaHei')
arr('phase_a6',1534,54,1567,54,GRAY)
txt('phase_received','客户收货',1625,24,166,59,34,font='Microsoft YaHei')
txt('order_amy','Amy',990,64,44,22,14)
txt('order_zhangyin','ZhangYin',1050,60,70,25,15,note='原图姓名识别为 ZhangYin，拼写待确认。')
arr('order_pair_right',1035,84,1057,84,width=.9)
arr('order_pair_left',1025,85,1003,85,width=.9)
txt('invoice_sales','= Sales.',1496,65,69,21,14)
path('ship_dots',[(1390,75),(1428,75)],BLACK,1.5,dashed=True)

# Components notes and the small bypass sketch.
txt('bd_dpc','BD / DPC',724,153,111,34,22,color='#70786D')
arr('bd_down',845,180,844,193,GRAY)
txt('invoice','Invoice',779,203,54,24,13,italic=True,underline=True)
txt('invoice_owner','CIC Luan ZhenJiao',824,186,188,32,16,note='负责人姓名按原图暂转写为 Luan ZhenJiao，姓名拼写待确认。')
bypass('components_bypass',922,207,63,21)
arr('components_continue',984,227,1012,227,width=.95)
underline('components_dash',1164,201,1192,199,GRAY,.8)

# Original upper-right red note, kept in place rather than turned into a new lane.
path('issue_red_frame',[(1255,242),(1248,129),(1251,122),(1506,127),(1774,144),(1776,260),(1510,250),(1255,252)],RED,1.3)
txt('issue_sebastian','Sebastian',1246,94,100,29,17,color=RED,underline=True,note='原图标题姓名按 Sebastian 转写，拼写待确认。')
txt('issue_title','= 新/旧切换，SoF翻…，…… ?',1332,95,327,29,18,color=RED,note='标题中 SoF 后的字迹不清，暂记为“翻…”，请核对原白板。',font='Microsoft YaHei')
txt('delivery_note','发货单',1266,165,57,28,17,font='Microsoft YaHei')
brace('delivery_brace',1314,157,56,width=.9)
txt('old_case','① 旧物料，自动发货',1327,153,171,30,15,font='Microsoft YaHei')
arr('old_case_arrow',1499,170,1518,170,GRAY,.8)
txt('old_case_invoice','自动开票',1523,153,77,31,15,font='Microsoft YaHei')
txt('old_license','旧：邮件拿许可证.',1627,150,137,29,13,note='原图此处疑为“旧：邮件拿许可证”，请确认“拿”字。',font='Microsoft YaHei')
txt('new_case','② 新：无法自动发货(发货单)',1327,182,206,29,14,font='Microsoft YaHei')
underline('new_case_underline',1385,207,1498,206,GRAY,.8)
arr('new_case_arrow',1536,198,1552,198,GRAY,.8)
txt('new_case_invoice','无法开票',1556,182,73,29,14,font='Microsoft YaHei')
arr('new_case_arrow2',1633,197,1648,197,GRAY,.8)
txt('no_license','无 license.',1653,182,110,29,14)
bypass('issue_bypass1',1397,209,66,18)
bypass('issue_bypass2',1668,203,57,21)
txt('fox_ele','FOX ELE',1789,105,119,33,23,note='原图右侧标记按 FOX ELE 转写，缩写待确认。')
arr('issue_right1',1811,153,1835,153,GRAY,.8)
arr('issue_right2',1811,227,1838,227,GRAY,.8)
txt('issue_right_dot','.',1842,221,9,16,14)

# TS row, including the two branches that were written on the board.
txt('ts_sales1','Sales / BD',349,277,105,37,20)
arr('ts_arrow1',450,306,480,306,GRAY)
txt('ts_sales2','Sales / BD',547,277,105,37,20)
arr('ts_arrow2',652,307,682,307)
txt('ts_excel','SWE: excel.',704,277,122,32,21)
txt('ts_pdf','Ni Rongling.pdf.',697,307,143,32,19)
arr('ts_quote_arrow',827,307,868,307)
path('ts_branch_up',[(882,304),(898,294),(918,285)],BLACK,1.1,True)
path('ts_branch_down',[(882,313),(899,330),(914,337)],BLACK,1.1,True)
txt('ts_stamp','客户盖章回传 pdf.',925,258,193,44,23,font='Microsoft YaHei')
txt('ts_approve','Approve',919,322,61,29,16)
arr('ts_approve_arrow',982,337,998,337,width=.9)
txt('ts_order','订单',981,302,61,41,28,font='Microsoft YaHei')
txt('ts_order_owner','Ni Rongling.',993,337,113,29,18)
arr('ts_order_arrow',1050,322,1100,322)
txt('ts_hq','Mia 找 HQ',1117,276,115,31,20)
underline('ts_hq_underline',1118,306,1157,305,GRAY,.9)
arr('ts_hq_arrow',1244,333,1298,333)
txt('ts_customer','Mia 给 AT / Customer',1308,274,207,32,19)
underline('ts_customer_underline',1309,306,1350,305,GRAY,.9)
txt('ts_record','Ni Rongling 录znd.',1296,335,186,34,19,note='“录”后的手写内容暂按 znd 转写，缩写待确认。')
arr('ts_customer_arrow',1435,331,1479,331)
arr('ts_far_arrow',1843,358,1856,359,GRAY,.8)
txt('ts_far_dot','.',1880,352,9,16,14)

# CS old-process row. Open brackets, rather than boxes, match the source.
txt('cs_sales','Sales',354,373,72,33,22)
txt('cs_mosaic','Mosaic',344,402,81,35,25,note='原图系统名按 Mosaic 转写。')
txt('cs_amy','(Amy)',401,428,49,23,14)
txt('cs_opp','<Opp.>',342,441,82,33,22)
arr('cs_arrow1',442,423,491,423)
txt('cs_sales2','Sales.',551,390,66,30,20)
txt('cs_inquiry','<Inquiry>',534,427,112,36,24)
txt('cs_email','E-mail.',635,390,65,29,19)
arr('cs_email_arrow',652,422,688,422)

path('engineer_group',[(736,361),(703,361),(691,578),(998,591),(1009,371)],'#798174',.9)
txt('engineer_star','*',710,348,38,39,38,color='#757E71')
txt('engineer_title','C.S. Engineer',750,375,135,32,19)
circled_number('engineer_number1','1',717,409,25)
txt('engineer_hierarchy','Hierarchy.',750,407,109,32,20)
circled_number('engineer_number2','2',715,445,25)
txt('engineer_bom','BOM',748,444,52,30,20)
txt('engineer_ax','<AX: 2nd>',799,443,101,30,19,note='原图按 AX: 2nd 转写，含义及缩写待确认。')
underline('ax_underline',842,468,882,466,BLACK,2.2)
txt('ax_note','不用',837,468,47,23,13,bold=True,note='BOM/AX 下方被加粗或涂改的字迹疑为“不用”，需核对。',font='Microsoft YaHei')
circled_number('engineer_number3','3',712,480,25)
txt('engineer_zt','ZT',746,478,32,31,21,note='第三项缩写疑为 ZT，待确认。')
txt('engineer_question','?',744,505,22,26,21)
brace('engineer_code_brace',770,480,62,width=.9)
txt('engineer_0400','0400',782,480,62,29,20)
path('engineer_more',[(801,513),(800,539)],BLACK,1.2,dashed=True)
arr('engineer_pricing',860,416,889,416)

txt('pricing','Pricing. (BP)',901,375,116,33,19)
brace('pricing_brace',903,408,35,width=.95)
txt('pricing_parts','元件',914,404,59,31,22,font='Microsoft YaHei')
txt('pricing_cs','CS项目',913,427,79,29,19,font='Microsoft YaHei')
underline('pricing_cs_underline',916,453,978,452,BLACK,.9)
path('price_approval_left',[(902,449),(890,450),(888,478),(901,479)],BLACK,1)
path('price_approval_right',[(977,448),(987,449),(987,479),(976,478)],BLACK,1)
txt('price_approval','价格审批',900,448,91,37,23,font='Microsoft YaHei')
txt('pricing_sd','SD',918,478,43,29,22)
arr('pricing_down',923,507,922,525)
txt('bella','Bella, SD',874,533,110,33,22)
arr('pricing_transfer',1001,418,1033,418)

txt('transfer_order','转订单',1035,382,94,46,29,font='Microsoft YaHei')
txt('transfer_cic','CIC(BP)/You Li',1031,428,107,29,15,note='原图下单负责人按 You Li 转写，拼写待确认。')
arr('transfer_arrow',1093,412,1119,412)
txt('production_order','生产单',1030,454,94,43,27,font='Microsoft YaHei')
txt('production_check','✓',1098,470,24,26,18)
txt('production_owner','Xiaoying Huang',1029,493,120,29,16,note='原图姓名按 Xiaoying Huang 转写，拼写待确认。')

path('codes_left_bracket',[(1142,398),(1126,397),(1116,595),(1141,601)],'#737B70',1)
txt('code_0400','0400  Sylun/YouLi',1148,400,239,44,27,bold=True,note='0400 后首个人名疑为 Sylun，姓名拼写待确认；YouLi 按原图连写。')
path('code_0480_red_frame',[(1128,497),(1127,447),(1459,459),(1458,505),(1127,497)],RED,1.5)
txt('code_0480','0480 Jinwei Feng.',1132,453,254,44,27,bold=True,note='原图姓名按 Jinwei Feng 转写，拼写待确认；红色问号为白板原有标记。')
txt('code_question','?',1286,430,32,35,29,color=RED)
txt('code_0481','0481',1128,520,78,42,28)
path('codes_more',[(1138,583),(1240,575)],BLACK,1.7,dashed=True)
arr('cs_far_arrow',1715,486,1764,486,GRAY,.85)
txt('cs_far_dot','.',1776,478,9,18,14)

# Standard uncompressed draw.io XML, with uncertainty confined to editable tooltips.
xml=minidom.parseString(ET.tostring(mf,encoding='utf-8')).toprettyxml(indent='  ',encoding='utf-8')
target=OUT/'业务流程图_白板原版布局.xml'
target.write_bytes(xml)
parsed=ET.parse(target)
all_ids=[e.get('id') for e in parsed.iter() if e.get('id')]
assert len(all_ids)==len(set(all_ids))
for c in parsed.findall('.//mxCell'):
    if c.get('parent'):assert c.get('parent') in all_ids
    assert 'image=' not in c.get('style','')
for v in visuals:
    if v['type'] in ['text','circle']:
        assert v['x']>=0 and v['y']>=0 and v['x']+v['w']<=W and v['y']+v['h']<=H,v['id']
    elif v['type']=='path':
        assert all(0<=x<=W and 0<=y<=H for x,y in v['pts']),v['id']

# Private, 2x preview of the exact geometry used in the XML.
S=2
im=Image.new('RGB',(W*S,H*S),'white');draw=ImageDraw.Draw(im)
fonts={}
def getfont(size,bold,cjk=False):
    key=(size,bold,cjk)
    if key not in fonts:
        if cjk:
            file='/System/Library/Fonts/STHeiti Medium.ttc' if bold else '/System/Library/Fonts/STHeiti Light.ttc'
        else:
            file='/System/Library/Fonts/Supplemental/Comic Sans MS Bold.ttf' if bold else '/System/Library/Fonts/Supplemental/Comic Sans MS.ttf'
        fonts[key]=ImageFont.truetype(file,round(size*S))
    return fonts[key]
def width(s,f):return draw.textlength(s,font=f)
def line(pts,color,w,dashed=False):
    points=[(x*S,y*S) for x,y in pts]
    if not dashed:draw.line(points,fill=color,width=max(1,round(w*S)))
    else:
        for a,b in zip(points,points[1:]):
            l=math.hypot(b[0]-a[0],b[1]-a[1])
            if not l:continue
            dx,dy=(b[0]-a[0])/l,(b[1]-a[1])/l
            offset=0
            while offset<l:
                stop=min(offset+3*S,l)
                draw.line((a[0]+dx*offset,a[1]+dy*offset,a[0]+dx*stop,a[1]+dy*stop),fill=color,width=max(1,round(w*S)))
                offset+=12*S
for v in visuals:
    if v['type']=='path':
        line(v['pts'],v['color'],v['width'],v['dashed'])
        if v['arrow']:
            a,b=v['pts'][-2:];ang=math.atan2(b[1]-a[1],b[0]-a[0])
            p=(b[0]-8*math.cos(ang)+4*math.sin(ang),b[1]-8*math.sin(ang)-4*math.cos(ang))
            q=(b[0]-8*math.cos(ang)-4*math.sin(ang),b[1]-8*math.sin(ang)+4*math.cos(ang))
            line([p,b,q],v['color'],v['width'])
    elif v['type']=='circle':
        draw.ellipse((v['x']*S,v['y']*S,(v['x']+v['w'])*S,(v['y']+v['h'])*S),outline=v['color'],width=2)
        f=getfont(v['size'],False)
        draw.text(((v['x']+v['w']/2)*S,(v['y']+v['h']/2)*S),v['label'],font=f,fill=v['color'],anchor='mm')
    else:
        cjk=any(ord(c)>0x2E80 for c in v['label']) or v['font']=='Microsoft YaHei'
        f=getfont(v['size'],v['bold'],cjk)
        tw=width(v['label'],f)
        # Draw at the intended point size. Report width issues instead of silently squeezing.
        if tw>v['w']*S+10:
            print('WIDTH',v['id'],round(tw/S,1),v['w'])
        x=v['x']*S
        if v['align']=='center':x+=(v['w']*S-tw)/2
        y=(v['y']+v['h']/2)*S
        draw.text((x,y),v['label'],font=f,fill=v['color'],anchor='lm')
        if v['underline']:line([(v['x'],v['y']+v['h']*.85),(v['x']+min(tw/S,v['w']),v['y']+v['h']*.85)],v['color'],.7)
im.save(BUILD/'白板布局预览.png')
im.crop((0,0,1992*S,270*S)).save(BUILD/'top_preview.png')
im.crop((310*S,270*S,1490*S,610*S)).save(BUILD/'bottom_preview.png')
(BUILD/'recognition_notes.json').write_text(json.dumps(uncertain,ensure_ascii=False,indent=2),encoding='utf-8')
print('Created:',target)
print('Editable text objects:',sum(v['type']=='text' for v in visuals),'Editable lines/arrows:',sum(v['type']=='path' for v in visuals),'Source-layout page:',W,H)
