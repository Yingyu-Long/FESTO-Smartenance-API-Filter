from core import *

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
im.save(OUT/'业务流程图_电子排版版_预览.png')
im.save(WORK/'flowchart_preview.png')
im.crop((250,920,2520,1340)).save(WORK/'cs_preview.png')
