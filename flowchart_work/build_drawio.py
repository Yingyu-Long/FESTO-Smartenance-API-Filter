from pathlib import Path
import xml.etree.ElementTree as ET
from xml.dom import minidom
from PIL import Image, ImageDraw, ImageFont

BASE = Path('/Users/albertlong/Documents/ChatGPT/FESTO')
OUT = BASE / 'output'
WORK = BASE / 'flowchart_work'
W, H = 2400, 1760
FONT = '/System/Library/Fonts/STHeiti Light.ttc'

mxfile = ET.Element('mxfile', host='app.diagrams.net', agent='Codex', version='24.7.17', type='device', compressed='false')
diagram = ET.SubElement(mxfile, 'diagram', id='business-process', name='业务流程')
model = ET.SubElement(diagram, 'mxGraphModel', dx=str(W), dy=str(H), grid='1', gridSize='10', guides='1', tooltips='1', connect='1', arrows='1', fold='1', page='1', pageScale='1', pageWidth=str(W), pageHeight=str(H), math='0', shadow='0')
root = ET.SubElement(model, 'root')
ET.SubElement(root, 'mxCell', id='0')
ET.SubElement(root, 'mxCell', id='1', parent='0')
groups = {'1': (0, 0)}
nodes = {}
visuals = []
edges = []

def geo(cell, x, y, w, h):
    ET.SubElement(cell, 'mxGeometry', x=str(x), y=str(y), width=str(w), height=str(h), attrib={'as': 'geometry'})

def group(id, x, y, w, h):
    cell = ET.SubElement(root, 'mxCell', id=id, value='', style='group;', vertex='1', connectable='0', parent='1')
    geo(cell, x, y, w, h)
    groups[id] = (x, y)

def node(id, text, x, y, w, h, parent='1', fill='#FFFFFF', stroke='#7890A7', color='#172B45', size=22, bold=False, align='center', radius=10, dashed=False, line=1.5, text_only=False):
    px, py = groups[parent]
    style = [f'rounded={int(radius > 0)}', 'whiteSpace=wrap', 'html=0', 'fontFamily=Microsoft YaHei', f'fontSize={size}', f'fontColor={color}', f'fontStyle={int(bold)}', f'align={align}', 'verticalAlign=middle', 'spacing=12', f'fillColor={fill}', f'strokeColor={stroke}', f'strokeWidth={line}', 'arcSize=10']
    if text_only:
        style += ['text', 'strokeColor=none', 'fillColor=none']
    if dashed:
        style += ['dashed=1', 'dashPattern=6 4']
    cell = ET.SubElement(root, 'mxCell', id=id, value=text, style=';'.join(style)+';', vertex='1', parent=parent)
    geo(cell, x-px, y-py, w, h)
    obj = dict(id=id, text=text, x=x, y=y, w=w, h=h, parent=parent, fill=fill, stroke=stroke, color=color, size=size, bold=bold, align=align, radius=radius, dashed=dashed, line=line, text_only=text_only)
    nodes[id] = obj
    visuals.append(obj)
    return obj

def edge(id, source, target, parent='1', label='', exit=(1,.5), entry=(0,.5), points=None, dashed=False, color='#52697F', both=False, preview_points=None):
    style = f'edgeStyle=orthogonalEdgeStyle;rounded=0;orthogonalLoop=1;jettySize=auto;html=0;endArrow=block;endFill=1;strokeColor={color};strokeWidth=2;fontSize=19;fontFamily=Microsoft YaHei;fontColor={color};labelBackgroundColor=#FFFFFF;exitX={exit[0]};exitY={exit[1]};exitDx=0;exitDy=0;entryX={entry[0]};entryY={entry[1]};entryDx=0;entryDy=0;'
    if dashed: style += 'dashed=1;dashPattern=6 4;'
    if both: style += 'startArrow=block;startFill=1;'
    cell = ET.SubElement(root, 'mxCell', id=id, value=label, style=style, edge='1', parent=parent, source=source, target=target)
    geom = ET.SubElement(cell, 'mxGeometry', relative='1', attrib={'as':'geometry'})
    if label:
        ET.SubElement(geom, 'mxPoint', x='0', y='-18', attrib={'as':'offset'})
    if points:
        px,py=groups[parent]
        arr=ET.SubElement(geom,'Array',attrib={'as':'points'})
        for x,y in points: ET.SubElement(arr,'mxPoint',x=str(x-px),y=str(y-py))
    a,b=nodes[source],nodes[target]
    start=(a['x']+a['w']*exit[0],a['y']+a['h']*exit[1])
    end=(b['x']+b['w']*entry[0],b['y']+b['h']*entry[1])
    pp=preview_points or points
    if pp is None:
        if start[0]==end[0] or start[1]==end[1]: pp=[]
        elif exit[0]==1 and entry[0]==0:
            mid=(start[0]+end[0])/2; pp=[(mid,start[1]),(mid,end[1])]
        else:
            mid=(start[1]+end[1])/2; pp=[(start[0],mid),(end[0],mid)]
    edges.append(dict(id=id,source=source,target=target,pts=[start]+pp+[end],color=color,label=label,dashed=dashed,both=both))

def lane(id, title, y, h, tint, titlefill, color='#172B45'):
    group(id,50,y,2300,h)
    node(id+'_background','',50,y,2300,h,parent=id,fill=tint,stroke='#D4DEE7',radius=0,line=1)
    node(id+'_title',title,50,y,180,h,parent=id,fill=titlefill,stroke='#D4DEE7',color=color,size=24 if id=='components' else 27,bold=True,radius=0,line=1)

node('title','业务流程图',50,25,1000,60,size=40,bold=True,align='left',text_only=True)
node('legend','浅橙色节点含待确认文字；省略号表示原图未展开的步骤。',1090,36,1260,40,size=20,color='#64748B',align='right',text_only=True)

phase_labels=['机会','需求','报价','下单','装配','发货 / 开票','客户收货']
for i,label in enumerate(phase_labels):
    node(f'phase_{i}',label,250+i*300,110,245,78,fill='#E5EEF8',stroke='#7C9DBD',size=27,bold=True)
for i in range(6): edge(f'phase_edge_{i}',f'phase_{i}',f'phase_{i+1}')
node('master_caption','主流程',50,110,180,78,size=26,bold=True,text_only=True)
node('order_note','Amy ↔ Zhangyin（姓名拼写待确认）',1100,195,660,42,fill='#FFF3DD',stroke='#E4B760',size=20)
node('invoice_note','开票：Sales',1750,195,350,42,size=20,color='#52697F',text_only=True)

lane('online','Online',260,130,'#F8FBFE','#E3EDF8')
node('app_world','App World',270,285,310,80,parent='online',fill='#FFFFFF',stroke='#8DA8C5',size=24)
node('fox','FoX\nXiaolong',620,285,330,80,parent='online',fill='#FFFFFF',stroke='#8DA8C5',size=23)

lane('components','Components',390,160,'#FBFCFD','#E9EDF2')
node('component_channels','SAP / CIC / Sales\nDPC？（原图带问号）',270,420,330,100,parent='components',fill='#FFF3DD',stroke='#DDB56B',size=22)
node('bd_dpc','BD / DPC',690,430,250,80,parent='components',size=24)
node('invoice_cic','Invoice / CIC\nLuan Zhenjiao（姓名待确认）',1020,415,400,110,parent='components',fill='#FFF3DD',stroke='#DDB56B',size=22)
node('component_next','…\n后续步骤原图未标注',1510,430,320,80,parent='components',stroke='#A4AFBB',dashed=True,size=21)
edge('component_1','bd_dpc','invoice_cic','components')
edge('component_2','invoice_cic','component_next','components',dashed=True)

lane('ts','TS',550,260,'#F5FBFA','#DCEFEA')
node('ts_opportunity','Sales / BD',270,640,190,82,parent='ts',fill='#FFFFFF',stroke='#76A79C',size=23)
node('ts_requirement','Sales / BD',520,640,190,82,parent='ts',fill='#FFFFFF',stroke='#76A79C',size=23)
node('ts_quote','SWE：Excel\nNi Rongling：PDF',770,625,255,112,parent='ts',fill='#FFFFFF',stroke='#76A79C',size=23)
node('ts_stamp','客户盖章回传\nPDF',1100,575,280,78,parent='ts',fill='#FFFFFF',stroke='#76A79C',size=22)
node('ts_order','Approve → 订单\nNi Rongling',1100,695,280,80,parent='ts',fill='#FFFFFF',stroke='#76A79C',size=22)
node('ts_hq','Mia 找 HQ',1450,695,220,80,parent='ts',fill='#FFFFFF',stroke='#76A79C',size=23)
node('ts_customer','Mia 给 AT / Customer\nNi Rongling 录入…（待确认）',1740,680,380,110,parent='ts',fill='#FFF3DD',stroke='#DDB56B',size=21)
node('ts_next','…',2200,695,100,80,parent='ts',stroke='#A4AFBB',dashed=True,size=28)
edge('ts_1','ts_opportunity','ts_requirement','ts')
edge('ts_2','ts_requirement','ts_quote','ts')
edge('ts_3a','ts_quote','ts_stamp','ts',exit=(1,.3),points=[(1060,658.6),(1060,614)])
edge('ts_3b','ts_quote','ts_order','ts',exit=(1,.75),points=[(1060,709),(1060,735)])
edge('ts_4','ts_order','ts_hq','ts')
edge('ts_5','ts_hq','ts_customer','ts')
edge('ts_6','ts_customer','ts_next','ts',dashed=True)

lane('cs','CS（旧）',810,440,'#FFFCF7','#F4E7D3')
node('cs_opportunity','Sales / Mosaic\nAmy\n〈Opp.〉',270,875,190,120,parent='cs',stroke='#B79A6B',size=22)
node('cs_inquiry','Sales\n〈Inquiry〉',520,885,190,100,parent='cs',stroke='#B79A6B',size=24)
node('cs_engineer','C.S. Engineer\n\n① Hierarchy\n② BOM（AX：2nd？）\n③ ZT？ / 0400 / …\n缩写待确认',800,855,300,270,parent='cs',fill='#FFF3DD',stroke='#DDB56B',size=22,align='left')
node('cs_pricing','Pricing（BP）\n\n元件 / CS项目\n价格审批：SD',1170,855,270,200,parent='cs',stroke='#B79A6B',size=23)
node('cs_bella','Bella / SD',1170,1135,270,70,parent='cs',stroke='#B79A6B',size=23)
node('cs_transfer','转订单\nCIC（BP）/ You Li',1510,890,260,90,parent='cs',stroke='#B79A6B',size=22)
node('cs_production','生产单\nXiaoying Huang\n（姓名拼写待确认）',1510,1070,260,125,parent='cs',fill='#FFF3DD',stroke='#DDB56B',size=21)
node('cs_0400','0400\nSyl… / You Li（姓名待确认）',1860,845,410,85,parent='cs',fill='#FFF3DD',stroke='#DDB56B',size=22)
node('cs_0480','0480 / Jinwei Feng\n？（原图带问号）',1860,965,410,85,parent='cs',fill='#FFF1EE',stroke='#CF7466',size=23,line=2)
node('cs_0481','0481',1860,1085,410,70,parent='cs',stroke='#B79A6B',size=24)
node('cs_more','…',1860,1170,410,45,parent='cs',size=24,text_only=True)
edge('cs_1','cs_opportunity','cs_inquiry','cs')
edge('cs_2','cs_inquiry','cs_engineer','cs',label='E-mail',entry=(0,.296296),preview_points=[])
edge('cs_3','cs_engineer','cs_pricing','cs',exit=(1,.37),entry=(0,.5))
edge('cs_4a','cs_pricing','cs_bella','cs',exit=(.5,1),entry=(.5,0))
edge('cs_4b','cs_pricing','cs_transfer','cs',exit=(1,.4),entry=(0,.5))
edge('cs_5a','cs_transfer','cs_production','cs',exit=(.5,1),entry=(.5,0))
edge('cs_5b','cs_transfer','cs_0400','cs',points=[(1810,935),(1810,887.5)])
edge('cs_5c','cs_transfer','cs_0480','cs',points=[(1810,935),(1810,1007.5)])
edge('cs_5d','cs_transfer','cs_0481','cs',points=[(1810,935),(1810,1120)])

group('exceptions',50,1290,2300,370)
node('exceptions_bg','',50,1290,2300,370,parent='exceptions',fill='#FFF9F8',stroke='#D48D83',radius=0,line=1.5)
node('exceptions_title','新 / 旧物料：发货与开票',80,1305,1000,55,parent='exceptions',size=29,bold=True,color='#8D3E35',align='left',text_only=True)
node('exceptions_owner','Sebastian；SoF…（原图缩写待确认）',1360,1310,930,48,parent='exceptions',size=21,color='#8D3E35',align='right',text_only=True)
node('old_material','旧物料',270,1390,240,80,parent='exceptions',fill='#E6F3EB',stroke='#7DA98C',size=24)
node('old_ship','自动发货',590,1390,270,80,parent='exceptions',fill='#E6F3EB',stroke='#7DA98C',size=24)
node('old_invoice','自动开票',940,1390,270,80,parent='exceptions',fill='#E6F3EB',stroke='#7DA98C',size=24)
node('old_license_note','旧：邮件拿许可证\n（文字待确认）',1330,1390,350,80,parent='exceptions',fill='#FFF3DD',stroke='#DDB56B',size=22)
node('fox_ele_note','FOX ELE（待确认）\n原图右侧补充标记',1810,1400,440,160,parent='exceptions',fill='#FFF3DD',stroke='#DDB56B',size=23,dashed=True)
node('new_material','新物料',270,1520,240,85,parent='exceptions',fill='#FBE4DF',stroke='#C78479',size=24)
node('new_ship','无法自动发货\n（发货单）',590,1520,270,85,parent='exceptions',fill='#FBE4DF',stroke='#C78479',size=23)
node('new_invoice','无法开票',940,1520,270,85,parent='exceptions',fill='#FBE4DF',stroke='#C78479',size=24)
node('new_license','无 license',1330,1520,350,85,parent='exceptions',fill='#FBE4DF',stroke='#C78479',size=24)
edge('old_1','old_material','old_ship','exceptions',color='#648671')
edge('old_2','old_ship','old_invoice','exceptions',color='#648671')
edge('new_1','new_material','new_ship','exceptions',color='#B5675D')
edge('new_2','new_ship','new_invoice','exceptions',color='#B5675D')
edge('new_3','new_invoice','new_license','exceptions',color='#B5675D')
node('footer','根据白板照片整理。人名、缩写及模糊文字的待确认标记均可直接修改。',50,1680,2300,42,size=20,color='#64748B',align='left',text_only=True)

# Write ordinary, uncompressed draw.io XML. Every label and connector remains native.
xml = minidom.parseString(ET.tostring(mxfile, encoding='utf-8')).toprettyxml(indent='  ', encoding='utf-8')
output = OUT / '业务流程图_可编辑.xml'
output.write_bytes(xml)

# Structural and geometric validation of the actual deliverable.
tree=ET.parse(output)
cells=tree.findall('.//mxCell')
ids=[c.get('id') for c in cells]
assert len(ids)==len(set(ids)), 'Duplicate cell ids'
for c in cells:
    for attr in ['parent','source','target']:
        if c.get(attr): assert c.get(attr) in ids, (c.get('id'),attr)
    assert c.get('style','').find('image=')==-1, 'Raster node found'
for obj in visuals:
    assert 0<=obj['x'] and 0<=obj['y'] and obj['x']+obj['w']<=W and obj['y']+obj['h']<=H

# Private preview from the same native-object geometry.
im=Image.new('RGB',(W,H),'white')
draw=ImageDraw.Draw(im)
fontcache={}
def font(sz):
    if sz not in fontcache: fontcache[sz]=ImageFont.truetype(FONT,sz)
    return fontcache[sz]
def dashed_line(a,b,color,width=2,dash=9,gap=6):
    import math
    length=math.hypot(b[0]-a[0],b[1]-a[1])
    if length==0:return
    dx,dy=(b[0]-a[0])/length,(b[1]-a[1])/length
    offset=0
    while offset<length:
        stop=min(offset+dash,length)
        draw.line((a[0]+dx*offset,a[1]+dy*offset,a[0]+dx*stop,a[1]+dy*stop),fill=color,width=width)
        offset+=dash+gap
def box(obj):
    x,y,w,h=obj['x'],obj['y'],obj['w'],obj['h']
    if not obj['text_only']:
        draw.rounded_rectangle((x,y,x+w,y+h),radius=obj['radius'],fill=obj['fill'],outline=obj['stroke'],width=max(1,round(obj['line'])))
        if obj['dashed']:
            for a,b in [((x,y),(x+w,y)),((x+w,y),(x+w,y+h)),((x+w,y+h),(x,y+h)),((x,y+h),(x,y))]:
                dashed_line(a,b,obj['stroke'])
def textdraw(obj):
    if not obj['text']:return
    f=font(obj['size']); lines=obj['text'].split('\n')
    widths=[draw.textlength(t,font=f) for t in lines]
    assert max(widths)<=obj['w']-12, (obj['id'],'text overflow',max(widths),obj['w'])
    lh=round(obj['size']*1.35); total=lh*len(lines)
    assert total<=obj['h']+6,(obj['id'],'height overflow',total,obj['h'])
    cy=obj['y']+(obj['h']-total)/2
    for line,tw in zip(lines,widths):
        if obj['align']=='left':tx=obj['x']+14
        elif obj['align']=='right':tx=obj['x']+obj['w']-tw-14
        else:tx=obj['x']+(obj['w']-tw)/2
        draw.text((tx,cy),line,font=f,fill=obj['color'],stroke_width=0,anchor='lt')
        cy+=lh
for obj in visuals: box(obj)
import math
def arrowhead(tip, prev, color):
    angle=math.atan2(tip[1]-prev[1],tip[0]-prev[0])
    length,width=12,5
    base=(tip[0]-length*math.cos(angle),tip[1]-length*math.sin(angle))
    draw.polygon([tip,(base[0]+width*math.sin(angle),base[1]-width*math.cos(angle)),(base[0]-width*math.sin(angle),base[1]+width*math.cos(angle))],fill=color)
for e in edges:
    pts=e['pts']
    for a,b in zip(pts,pts[1:]):
        if e['dashed']:dashed_line(a,b,e['color'])
        else:draw.line([a,b],fill=e['color'],width=2)
    arrowhead(pts[-1],pts[-2],e['color'])
    if e['both']:arrowhead(pts[0],pts[1],e['color'])
    if e['label']:
        mid=((pts[0][0]+pts[-1][0])/2,(pts[0][1]+pts[-1][1])/2-30)
        f=font(19); tw=draw.textlength(e['label'],font=f)
        draw.rectangle((mid[0]-tw/2-3,mid[1]-2,mid[0]+tw/2+3,mid[1]+26),fill='white')
        draw.text((mid[0]-tw/2,mid[1]),e['label'],fill=e['color'],font=f,anchor='lt')
for obj in visuals:textdraw(obj)
im.save(WORK/'flowchart_preview.png')
im.crop((230,810,2310,1250)).save(WORK/'cs_preview.png')
print(f'Created {output}')
print(f'{len([c for c in cells if c.get("vertex")=="1"])} editable shapes; {len(edges)} native connectors; XML validation passed.')
