from pathlib import Path
import xml.etree.ElementTree as ET
from xml.dom import minidom
from PIL import Image, ImageDraw, ImageFont

BASE = Path('/Users/albertlong/Documents/ChatGPT/FESTO')
OUT = BASE / 'output'
WORK = BASE / 'flowchart_work/electronic'
W, H = 2600, 1400
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

def node(id, text, x, y, w, h, parent='1', fill='#FFFFFF', stroke='#90A5B6', color='#263E50', size=24, bold=False, align='center', radius=10, dashed=False, line=1.5, text_only=False, note=None):
    px, py = groups[parent]
    style = [f'rounded={int(radius > 0)}', 'whiteSpace=wrap', 'html=0', 'fontFamily=Microsoft YaHei', f'fontSize={size}', f'fontColor={color}', f'fontStyle={int(bold)}', f'align={align}', 'verticalAlign=middle', 'spacing=12', f'fillColor={fill}', f'strokeColor={stroke}', f'strokeWidth={line}', 'arcSize=10']
    if text_only:
        style += ['text', 'strokeColor=none', 'fillColor=none']
    if dashed:
        style += ['dashed=1', 'dashPattern=6 4']
    if note:
        wrapper = ET.SubElement(root, 'object', id=id, label=text, tooltip=note)
        cell = ET.SubElement(wrapper, 'mxCell', style=';'.join(style)+';', vertex='1', parent=parent)
    else:
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
    pp=preview_points if preview_points is not None else points
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

