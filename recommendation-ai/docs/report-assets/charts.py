import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
plt.rcParams.update({'font.family':'Segoe UI','font.size':11,'axes.spines.top':False,'axes.spines.right':False,'axes.edgecolor':'#888','axes.labelcolor':'#333','xtick.color':'#333','ytick.color':'#333'})
ACC='#2a7a52'; BASE='#9aa3ad'
# 1. warm start P@5 and NDCG@5 small multiples
m=['Random','Phổ biến','Luật SQL cũ','CF-only','Content-only','Hybrid','Hybrid không khám phá','Oracle (tham chiếu)']
p=[0.009,0.008,0.083,0.095,0.018,0.095,0.106,0.240]; ps=[0.010,0.005,0.022,0.023,0.006,0.021,0.017,0.029]
n=[0.018,0.016,0.201,0.211,0.035,0.250,0.264,0.651]; ns=[0.023,0.013,0.038,0.047,0.015,0.043,0.041,0.065]
fig,axs=plt.subplots(1,2,figsize=(10,4.2),sharey=True)
for ax,v,s,t in [(axs[0],p,ps,'P@5'),(axs[1],n,ns,'NDCG@5')]:
    cols=[ACC if x=='Hybrid' else ('#cfd5db' if 'Oracle' in x else BASE) for x in m]
    y=range(len(m))[::-1]
    ax.barh(list(y),v,xerr=s,color=cols,height=0.62,error_kw={'ecolor':'#555','capsize':3,'lw':1})
    for yy,vv,ss in zip(y,v,s): ax.text(vv+ss+max(v)*0.025,yy-0.05,f'{vv:.3f}'.replace('.',','),va='center',fontsize=9.5,color='#333')
    ax.set_xlim(0,max(v)*1.28); ax.set_title(t,fontsize=12,loc='left',color='#222'); ax.grid(axis='x',color='#e6e6e6'); ax.set_axisbelow(True)
axs[0].set_yticks(list(range(len(m))[::-1])); axs[0].set_yticklabels(m)
fig.tight_layout(); fig.savefig('c1-warm.png',dpi=200)
# 2. paired differences forest
rows=[('Hybrid − CF-only','NDCG@5',0.039,0.003,0.075),('Hybrid − CF-only','P@5',-0.000,-0.019,0.019),
('Hybrid − Luật cũ','NDCG@5',0.049,0.008,0.091),('Hybrid − Luật cũ','P@5',0.011,-0.009,0.032),
('Hybrid − không khám phá','P@5',-0.011,-0.016,-0.007),
('Bài mới: Content − CF','P@5',0.018,0.011,0.026),('Bài mới: Hybrid − Luật cũ','P@5',-0.095,-0.112,-0.078),
('Người dùng mới: Hybrid ép − Luật cũ','P@5',0.004,-0.014,0.022)]
fig,ax=plt.subplots(figsize=(10,4.2))
for i,(a,mm,c,lo,hi) in enumerate(rows[::-1]):
    sig = lo>0 or hi<0
    col = ACC if (sig and c>0) else ('#b5523b' if sig else BASE)
    ax.plot([lo,hi],[i,i],color=col,lw=2); ax.plot(c,i,'o',color=col,ms=8,mec='white',mew=1.5)
    ax.text(0.125,i,f'{c:+.3f} (từ {lo:.3f} đến {hi:.3f})'.replace('.',','),va='center',fontsize=9.5,color='#333')
ax.axvline(0,color='#555',lw=1,ls='--')
ax.set_yticks(range(len(rows))); ax.set_yticklabels([f'{a} ({mm})' for a,mm,*_ in rows[::-1]])
ax.set_xlim(-0.13,0.24); ax.set_xlabel('Chênh lệch theo cặp, khoảng tin cậy 95% (10 seed)'); ax.grid(axis='x',color='#eee'); ax.set_axisbelow(True)
fig.tight_layout(); fig.savefig('c2-paired.png',dpi=200)
# 3. LR weights (standardised) real-stack model
f=['cf_score','follows_artist','genre_overlap','survey_match','popularity','skip_rate','content_sim','recency']
w=[1.4100,0.8432,0.5928,0.2372,0.1729,0.0968,-0.1060,-0.2540]
fig,ax=plt.subplots(figsize=(8,3.6))
y=range(len(f))[::-1]
ax.barh(list(y),w,color=[ACC if x>0 else '#b5523b' for x in w],height=0.6)
for yy,ww in zip(y,w): ax.text(ww+(0.03 if ww>0 else -0.03),yy,f'{ww:+.3f}'.replace('.',','),va='center',ha='left' if ww>0 else 'right',fontsize=9.5)
ax.axvline(0,color='#555',lw=1); ax.set_yticks(list(y)); ax.set_yticklabels(f); ax.set_xlim(-0.55,1.7)
ax.set_xlabel('Trọng số chuẩn hóa (w·σ) của model lr-20261121T171200Z'); ax.grid(axis='x',color='#eee'); ax.set_axisbelow(True)
fig.tight_layout(); fig.savefig('c3-weights.png',dpi=200)
print('ok')
