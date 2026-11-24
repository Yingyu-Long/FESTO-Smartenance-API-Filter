from core import *

NAVY='#294B68'
BLUE='#EAF1F8'
BORDER='#A3B4C3'
MUTED='#617586'
RED='#B86C6C'
RED_FILL='#FFF4F2'

def band(id,title,y,h):
    group(id,60,y,2480,h)
    node(id+'_bg','',60,y,2480,h,parent=id,fill='#FFFFFF',stroke='#DFE6EC',radius=0,line=1)
    node(id+'_label',title,60,y,180,h,parent=id,fill='#F1F5F8',stroke='#DFE6EC',color=NAVY,size=23 if id=='components' else 26,bold=True,radius=0,line=1)

node('title','业务流程图',60,30,900,60,size=38,bold=True,align='left',color=NAVY,text_only=True)
node('main_label','主流程',60,110,180,78,size=26,bold=True,color=NAVY,text_only=True)
for i,label in enumerate(['机会','需求','报价','下单','装配','发货 / 开票','客户收货']):
    node('stage_'+str(i),label,280+i*320,110,270,78,fill=BLUE,stroke='#7F9BB3',size=28,bold=True,color=NAVY)
for i in range(6):edge('stage_arrow_'+str(i),'stage_'+str(i),'stage_'+str(i+1))
node('order_collaboration','Amy ↔ ZhangYin',1220,198,430,38,size=21,color=MUTED,text_only=True,note='原图下单处的双向协作标记。ZhangYin 姓名拼写待确认。')
node('invoice_owner','开票：Sales',1880,198,270,38,size=21,color=MUTED,text_only=True)

# Keep the two top channels in their source positions; the shipping note sits to their right.
group('top_lanes',60,260,1300,340)
node('top_lanes_bg','',60,260,1300,340,parent='top_lanes',fill='#FFFFFF',stroke='#DFE6EC',radius=0,line=1)
node('online_label','Online',60,260,180,130,parent='top_lanes',fill='#F1F5F8',stroke='#DFE6EC',color=NAVY,size=26,bold=True,radius=0,line=1)
node('components_label','Components',60,390,180,210,parent='top_lanes',fill='#F1F5F8',stroke='#DFE6EC',color=NAVY,size=23,bold=True,radius=0,line=1)
node('online_divider','',240,389,1120,1,parent='top_lanes',fill='#DFE6EC',stroke='#DFE6EC',radius=0,line=0)
node('app_world','App World',280,287,250,76,parent='top_lanes')
node('fox','FoX\nXiaolong',580,277,270,96,parent='top_lanes',note='原图 FoX 括号内姓名转写为 Xiaolong，拼写待确认。')
node('component_systems','SAP / CIC / Sales\nDPC？',280,442,285,106,parent='top_lanes',size=23,note='DPC 后问号为白板原有内容。此处为渠道或系统列表，原图未画出到 BD/DPC 的连线。')
node('component_bd','BD / DPC',635,457,190,76,parent='top_lanes')
node('component_invoice','Invoice / CIC\nLuan ZhenJiao',895,442,290,106,parent='top_lanes',size=23,note='负责人姓名按 Luan ZhenJiao 转写，拼写待确认。')
node('component_next','…',1250,457,70,76,parent='top_lanes',dashed=True,size=28)
edge('component_arrow1','component_bd','component_invoice','top_lanes')
edge('component_arrow2','component_invoice','component_next','top_lanes',dashed=True)

group('shipping_notes',1420,260,1120,340)
node('shipping_bg','',1420,260,1120,340,parent='shipping_notes',fill='#FFFCFB',stroke='#D6A19A',radius=0,line=1.5)
node('shipping_title','新 / 旧物料：发货与开票',1450,274,750,45,parent='shipping_notes',size=27,bold=True,color='#974E49',align='left',text_only=True)
node('shipping_note','Sebastian · 新/旧切换 · SoF…',1450,321,790,33,parent='shipping_notes',size=19,color=MUTED,align='left',text_only=True,note='原图标题的 Sebastian 姓名、SoF 后手写内容待确认。')
node('shipping_fox','FOX ELE',2300,319,210,36,parent='shipping_notes',size=21,color=MUTED,text_only=True,note='原图右侧独立标记，暂转写为 FOX ELE。原图未明示其与具体步骤的连接关系。')
node('old_material','旧物料',1450,378,160,78,parent='shipping_notes',fill=BLUE,stroke=BORDER,size=24)
node('old_shipping','自动发货',1660,378,210,78,parent='shipping_notes',stroke=BORDER)
node('old_invoice','自动开票',1920,378,210,78,parent='shipping_notes',stroke=BORDER)
node('old_license','旧：邮件拿许可证',2180,378,320,78,parent='shipping_notes',size=22,stroke='#CDD7DE',note='原图疑为“旧：邮件拿许可证”，其中“拿”字待核对。原图仅列补充说明，未画连线。')
node('new_material','新物料',1450,498,160,78,parent='shipping_notes',fill=RED_FILL,stroke='#C78D85')
node('new_shipping','无法自动发货\n（发货单）',1660,483,210,108,parent='shipping_notes',fill=RED_FILL,stroke='#C78D85',size=23)
node('new_invoice','无法开票',1920,498,210,78,parent='shipping_notes',fill=RED_FILL,stroke='#C78D85')
node('new_license','无 license',2180,498,320,78,parent='shipping_notes',fill=RED_FILL,stroke='#C78D85')
edge('old_arrow1','old_material','old_shipping','shipping_notes')
edge('old_arrow2','old_shipping','old_invoice','shipping_notes')
edge('new_arrow1','new_material','new_shipping','shipping_notes',color=RED)
edge('new_arrow2','new_shipping','new_invoice','shipping_notes',color=RED)
edge('new_arrow3','new_invoice','new_license','shipping_notes',color=RED)

band('ts','TS',640,260)
node('ts_sales1','Sales / BD',280,733,200,84,parent='ts')
node('ts_sales2','Sales / BD',550,733,200,84,parent='ts')
node('ts_quote','SWE：Excel\nNi Rongling：PDF',820,720,280,110,parent='ts',size=23)
node('ts_stamp','客户盖章回传\nPDF',1180,658,300,86,parent='ts',size=24)
node('ts_order','Approve → 订单\nNi Rongling',1180,790,300,86,parent='ts',size=23)
node('ts_hq','Mia 找 HQ',1550,790,220,86,parent='ts')
node('ts_customer','Mia 给 AT / Customer\nNi Rongling 录 znd',1840,778,420,110,parent='ts',size=23,note='Ni Rongling 后的“录 znd”按字形转写，缩写待确认。')
node('ts_next','…',2340,790,140,86,parent='ts',dashed=True,size=28)
edge('ts_arrow1','ts_sales1','ts_sales2','ts')
edge('ts_arrow2','ts_sales2','ts_quote','ts')
edge('ts_branch_stamp','ts_quote','ts_stamp','ts',exit=(1,.3),points=[(1140,753),(1140,701)])
edge('ts_branch_order','ts_quote','ts_order','ts',exit=(1,.75),points=[(1140,802.5),(1140,833)])
edge('ts_arrow3','ts_order','ts_hq','ts')
edge('ts_arrow4','ts_hq','ts_customer','ts')
edge('ts_arrow5','ts_customer','ts_next','ts',dashed=True)

band('cs','CS（旧）',940,400)
node('cs_opp','Sales / Mosaic\nAmy · Opp.',280,1030,210,110,parent='cs',size=23,note='原图 Mosaic / Amy / Opp. 的组合，名称保留原英文。')
node('cs_inquiry','Sales\nInquiry',560,1040,200,90,parent='cs')
node('cs_engineer','C.S. Engineer\n\n① Hierarchy\n② BOM（AX: 2nd）\n③ ZT？ / 0400 / …',850,985,300,260,parent='cs',size=22,align='left',note='AX: 2nd 和 ZT 的缩写待确认。原图 BOM 下方加粗/涂改文字疑为“不用”，待核对。第三项的问号为原图标记。')
node('cs_pricing','Pricing（BP）\n元件 / CS项目\n价格审批：SD',1230,995,260,180,parent='cs',size=23)
node('cs_bella','Bella / SD',1230,1245,260,66,parent='cs',size=23)
node('cs_transfer','转订单\nCIC（BP）/ You Li',1570,1040,260,90,parent='cs',size=22,note='You Li 为原图负责人姓名转写，拼写待确认。')
node('cs_production','生产单\nXiaoying Huang',1570,1215,260,96,parent='cs',size=22,note='负责人姓名按 Xiaoying Huang 转写，拼写待确认。')
node('cs_0400','0400 / Sylun / You Li',1920,985,560,82,parent='cs',size=25,note='0400 后首个人名疑为 Sylun，拼写待确认。')
node('cs_0480','0480 / Jinwei Feng  ?',1920,1110,560,82,parent='cs',fill=RED_FILL,stroke=RED,line=2,size=25,note='Jinwei Feng 的姓名拼写待确认。问号和红框为白板原有标记。')
node('cs_0481','0481',1920,1235,560,66,parent='cs',size=25)
node('cs_more','…',2110,1305,180,28,parent='cs',size=21,color=MUTED,text_only=True,note='保留原图编号列表下方的省略号，后续编号未展开。')
edge('cs_arrow1','cs_opp','cs_inquiry','cs')
edge('cs_arrow2','cs_inquiry','cs_engineer','cs',label='E-mail',entry=(0,100/260))
edge('cs_arrow3','cs_engineer','cs_pricing','cs',exit=(1,100/260),entry=(0,.5))
edge('cs_bella_arrow','cs_pricing','cs_bella','cs',exit=(.5,1),entry=(.5,0))
edge('cs_transfer_arrow','cs_pricing','cs_transfer','cs')
edge('cs_production_arrow','cs_transfer','cs_production','cs',exit=(.5,1),entry=(.5,0))
edge('cs_code0400','cs_transfer','cs_0400','cs',points=[(1870,1085),(1870,1026)])
edge('cs_code0480','cs_transfer','cs_0480','cs',points=[(1870,1085),(1870,1151)])
edge('cs_code0481','cs_transfer','cs_0481','cs',points=[(1870,1085),(1870,1268)])

# XML objects contain editable labels and optional recognition notes, with bound connectors.
xml=minidom.parseString(ET.tostring(mxfile,encoding='utf-8')).toprettyxml(indent='  ',encoding='utf-8')
target=OUT/'业务流程图_电子排版版.xml'
target.write_bytes(xml)
tree=ET.parse(target)
ids=[x.get('id') for x in tree.iter() if x.get('id')]
assert len(ids)==len(set(ids))
cells=tree.findall('.//mxCell')
for c in cells:
    for key in ('parent','source','target'):
        if c.get(key):assert c.get(key) in ids,(c.get('id'),key)
    assert 'image=' not in c.get('style','')
for e in edges:
    assert e['source'] in nodes and e['target'] in nodes
for o in visuals:
    assert o['x']>=0 and o['y']>=0 and o['x']+o['w']<=W and o['y']+o['h']<=H,o['id']

import render
print('Created:',target)
print('Native vertices:',len(visuals),'Attached connectors:',len(edges))
