import { useState, useEffect, useRef } from "react"
import * as XLSX from "xlsx"
import { db, dbSet, dbListen, dbPush, dbRemove, dbGet, initIfEmpty } from "./firebase"
import { ref } from "firebase/database"
import {
  DISCOUNT_DAYS, INITIAL_PRODUCTS, INITIAL_EVENT, DEFAULT_STORES,
  INITIAL_TICKER, INITIAL_WEEKLY, AREAS, CATS, CAT, RANK
} from "./data"

// ─── ユーティリティ
const isTsuruhaDay = () => { const d = new Date().getDate(); return d===1||d===10||d===20 }
const gpN = (p,c) => p>0 ? Math.round((p-c)/p*100) : 0
const fmtJP = (n) => { if(n>=100000000) return `${(n/100000000).toFixed(1)}億円`; if(n>=10000) return `${Math.round(n/10000)}万円`; return `${n.toLocaleString()}円` }
const safeNum = (s) => Number(String(s||0).replace(/,/g,""))||0
const fmt = v => `¥${Number(v||0).toLocaleString()}`

// Excelパーサー
function parseExcelFile(file) {
  return new Promise((resolve,reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(e.target.result,{type:"binary"})
        const result = {products:null,eventProducts:null}
        const regSheet = wb.SheetNames.find(n=>n.includes("レギュラー")||n.includes("価格表"))
        if (regSheet) {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[regSheet],{header:1,defval:null})
          const prods=[]; let cat=""; let stop=false
          rows.forEach((row,ri) => {
            if(stop||!row||row.length<8) return
            const cv=row[1]?String(row[1]).trim():""
            if(cv==="催事"){stop=true;return}
            if(cv&&cv!=="レギュラー") cat=(cv==="土物"?"土もの":cv)
            const rack=row[2]?String(row[2]).trim():""
            if(!/^[A-Z]\d+$/.test(rack)) return
            const name=row[3]?String(row[3]).trim():""
            const spec=row[5]?String(row[5]).replace(/\u3000/g,"").trim():""
            const origin=row[7]?String(row[7]).replace(/\u3000/g,"").trim():""
            const price=Number(row[8])||0, cost=Number(row[9])||0
            const displayQty=Number(row[11])||0, makeQty=Number(row[12])||0
            if(!name||!price) return
            const fullName=(spec?`${name} ${spec}`:name).replace(/\u3000/g,"").trim()
            prods.push({id:`XL_${ri}`,rack,cat:cat||"根菜",name:fullName,origin,price,cost,displayQty,makeQty})
          })
          if(prods.length>3) result.products=prods
        }
        const evSheet = wb.SheetNames.find(n=>n.includes("催事")&&n.includes("パート"))
        if(evSheet){
          const rows=XLSX.utils.sheet_to_json(wb.Sheets[evSheet],{header:1,defval:null})
          const evProds=[]
          rows.forEach((row,ri) => {
            if(!row) return
            const num=Number(row[1]); if(!num||isNaN(num)||num<=0) return
            const price=Number(row[2])||0, name=row[3]?String(row[3]).trim():"", qty=Number(row[5])||0, cost=Number(row[6])||0
            if(!name||!price) return
            evProds.push({id:`EV_${ri}`,num,name,price,cost,qty,note:""})
          })
          if(evProds.length>0) result.eventProducts=evProds
        }
        resolve(result)
      } catch(err){reject(err)}
    }
    reader.readAsBinaryString(file)
  })
}

function parseStoreFile(file){
  return new Promise((resolve,reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try{
        const wb=XLSX.read(e.target.result,{type:"binary"})
        const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:null})
        const stores=[]
        rows.forEach((row,ri) => {
          if(ri<2) return
          if(String(row[0]||"").trim()!=="済") return
          const rank=row[4]?String(row[4]).trim():""; if(!rank) return
          const id=Number(row[1])||ri
          const area=row[2]?String(row[2]).trim():""
          let name=row[3]?String(row[3]).trim():""; if(!name.endsWith("店")) name+="店"
          const isSelf=(row[9]?String(row[9]).trim():"").includes("自社")
          stores.push({id,area,name,rank,logistics:isSelf?"自社":"アサヒ",time:row[11]?String(row[11]).trim():"―",deliveryDays:isSelf?"月〜土":"アサヒ便",shelfSize:row[5]?String(row[5]).trim():"―",eventSetup:row[6]?String(row[6]).trim():"なし",outsideSale:row[8]?String(row[8]).trim():"―",advisors:row[10]?String(row[10]).trim():"―",note:area==="会津"?"冷蔵なし":""})
        })
        resolve(stores)
      }catch(err){reject(err)}
    }
    reader.readAsBinaryString(file)
  })
}

function parseReport(text){
  if(!text||text.trim().length<10) return null
  try{
    const c=text.replace(/\r/g,"")
    const pM=c.match(/対象期間[：:]\s*([^\n（(]+)/)
    const qM=c.match(/総数量[：:]\s*([\d,]+)\s*点/)
    const sM=c.match(/総売上[：:]\s*([\d,]+)\s*円/)
    const aM=c.match(/平均単価[\s　]*([\d,.]+)\s*円/)
    const sr=[]; const re=/(\d+)\.\s*([^：:\n]+)[：:]\s*([\d,]+)\s*円[（(]([\d.]+)%[)）]/g; let m
    while((m=re.exec(c))!==null) sr.push({rank:safeNum(m[1]),name:(m[2]||"").trim(),sales:safeNum(m[3]),pct:safeNum(m[4])})
    const ps=[]; const dS=c.match(/D\)[^\n]*\n([\s\S]*?)(?=E\)|$)/)
    if(dS&&dS[1]){const r2=/[•·]\s*([^：:\n]+)[：:]\s*([\d,]+)\s*円[（(]([\d.]+)%[)）]/g;let m2;while((m2=r2.exec(dS[1]))!==null)ps.push({name:(m2[1]||"").trim(),sales:safeNum(m2[2]),pct:safeNum(m2[3])})}
    return {period:pM?String(pM[1]||"").trim():"",totalQty:qM?safeNum(qM[1]):0,totalSales:sM?safeNum(sM[1]):0,avgPrice:aM?safeNum(aM[1]):0,storeRanking:sr,prodSales:ps}
  }catch(e){return null}
}

// ─── メインコンポーネント
export default function App() {
  const festive = isTsuruhaDay()
  const accent  = festive ? "#dc2626" : "#4a7c59"
  const accentL = festive ? "#fee2e2" : "#dcfce7"

  const [now,setNow] = useState(new Date())
  useEffect(()=>{const t=setInterval(()=>setNow(new Date()),1000);return()=>clearInterval(t)},[])

  // ── ローカルUI state
  const [tab,setTab]             = useState("dashboard")
  const [area,setArea]           = useState("全エリア")
  const [catFilter,setCatFilter] = useState("全品目")
  const [shelfEdit,setShelfEdit] = useState(false)
  const [inputOpen,setInputOpen] = useState(false)
  const [pasteText,setPasteText] = useState("")
  const [parseError,setParseError] = useState(false)
  const [reportFormOpen,setReportFormOpen] = useState(false)
  const [newReport,setNewReport] = useState({date:"",name:"",note:"",storeMsg:""})
  const [editTMsg,setEditTMsg]   = useState("")
  const [editTIcon,setEditTIcon] = useState("📢")
  const [xlsxImporting,setXlsxImporting] = useState(false)
  const [xlsxResult,setXlsxResult]       = useState(null)
  const [xlsxError,setXlsxError]         = useState("")
  const [storeImporting,setStoreImporting] = useState(false)
  const [storeImportResult,setStoreImportResult] = useState(null)
  const [storeImportError,setStoreImportError]   = useState("")
  const [dbReady,setDbReady]     = useState(false)
  const [tickerIdx,setTickerIdx] = useState(0)

  // ── Firebase同期 state（全スタッフ共有）
  const [products,setProducts]         = useState(INITIAL_PRODUCTS)
  const [eventProducts,setEventProducts] = useState(INITIAL_EVENT)
  const [stores,setStores]             = useState(DEFAULT_STORES)
  const [shipDate,setShipDateState]    = useState(new Date().toISOString().slice(0,10))
  const [shipReport,setShipReport]     = useState({})
  const [centerStock,setCenterStock]   = useState({})
  const [displayDates,setDisplayDates] = useState({})
  const [weeklyReports,setWeeklyReports] = useState([])
  const [tickerItems,setTickerItems]   = useState(INITIAL_TICKER)
  const [reportData,setReportData]     = useState(null)

  const xlsxRef  = useRef()
  const storeRef = useRef()
  const debounceRef = useRef({})

  // デバウンス書き込みヘルパー
  const debouncedWrite = (path, val, delay=600) => {
    if(debounceRef.current[path]) clearTimeout(debounceRef.current[path])
    debounceRef.current[path] = setTimeout(()=>{ dbSet(path, val) }, delay)
  }

  // ── Firebase初期化 & 初期データ投入
  useEffect(()=>{
    const init = async () => {
      await initIfEmpty("products", INITIAL_PRODUCTS)
      await initIfEmpty("eventProducts", INITIAL_EVENT)
      await initIfEmpty("stores", DEFAULT_STORES)
      await initIfEmpty("shipDate", new Date().toISOString().slice(0,10))
      await initIfEmpty("shipReport", {})
      await initIfEmpty("centerStock", {})
      await initIfEmpty("displayDates", {})
      await initIfEmpty("tickerItems", INITIAL_TICKER)
      // weeklyReports: pushで追加するため個別に初期化
      const snap = await dbGet("weeklyReports")
      if(!snap.exists()){
        for(const r of INITIAL_WEEKLY){ await dbPush("weeklyReports", r) }
      }
      setDbReady(true)
    }
    init()
  },[])

  // ── Firebase リスナー登録
  useEffect(()=>{
    if(!dbReady) return
    const unsubs = [
      dbListen("products",       v => v && setProducts(Array.isArray(v)?v:Object.values(v))),
      dbListen("eventProducts",  v => v && setEventProducts(Array.isArray(v)?v:Object.values(v))),
      dbListen("stores",         v => v && setStores(Array.isArray(v)?v:Object.values(v))),
      dbListen("shipDate",       v => v && setShipDateState(v)),
      dbListen("shipReport",     v => setShipReport(v||{})),
      dbListen("centerStock",    v => setCenterStock(v||{})),
      dbListen("displayDates",   v => setDisplayDates(v||{})),
      dbListen("tickerItems",    v => v && setTickerItems(Array.isArray(v)?v:Object.values(v))),
      dbListen("reportData",     v => setReportData(v||null)),
      dbListen("weeklyReports",  v => {
        if(!v) return
        const arr = Object.entries(v).map(([k,r])=>({...r, _key:k}))
        arr.sort((a,b)=>new Date(b.date)-new Date(a.date))
        setWeeklyReports(arr)
      }),
    ]
    return () => unsubs.forEach(u=>u())
  },[dbReady])

  // ティッカー自動切替
  useEffect(()=>{
    if(!tickerItems.length) return
    const t=setInterval(()=>setTickerIdx(x=>(x+1)%tickerItems.length),4000)
    return()=>clearInterval(t)
  },[tickerItems.length])

  // ── Firebase書き込み関数群
  const setShipDate = (v) => { setShipDateState(v); dbSet("shipDate", v) }

  const updateShipReport = (storeId, field, val) => {
    const next = {...(shipReport[storeId]||{}), [field]:val}
    setShipReport(prev=>({...prev,[storeId]:next}))
    debouncedWrite(`shipReport/${storeId}`, next)
  }

  const updateCenterStock = (productId, val) => {
    setCenterStock(prev=>({...prev,[productId]:val}))
    debouncedWrite(`centerStock/${productId}`, val)
  }

  const updateDisplayDate = (productId, val) => {
    setDisplayDates(prev=>({...prev,[productId]:val}))
    debouncedWrite(`displayDates/${productId}`, val)
  }

  const updateProduct = (id, field, val) => {
    const next = products.map(p=>p.id===id?{...p,[field]:["price","cost","makeQty","displayQty"].includes(field)?Number(val)||0:val}:p)
    setProducts(next)
    debouncedWrite("products", next, 1000)
  }

  const addWeeklyReport = (r) => {
    dbPush("weeklyReports", {...r, isNew:true, mgRead:false, createdAt: Date.now()})
  }

  const markMgRead = (key) => {
    dbSet(`weeklyReports/${key}/mgRead`, true)
    dbSet(`weeklyReports/${key}/isNew`, false)
  }

  const addTickerItem = () => {
    if(!editTMsg.trim()) return
    const next=[...tickerItems, {icon:editTIcon, msg:editTMsg.trim()}]
    dbSet("tickerItems", next)
    setEditTMsg(""); setEditTIcon("📢")
  }

  const removeTickerItem = (i) => {
    const next=tickerItems.filter((_,idx)=>idx!==i)
    dbSet("tickerItems", next)
  }

  const updateTickerItem = (i, field, val) => {
    const next=tickerItems.map((t,idx)=>idx===i?{...t,[field]:val}:t)
    setTickerItems(next)
    debouncedWrite("tickerItems", next, 800)
  }

  // レポート適用
  const handleApply = () => {
    const p = parseReport(pasteText)
    if(!p){setParseError(true);return}
    const has=(p.totalSales||0)>0||(p.totalQty||0)>0||(p.storeRanking||[]).length>0
    if(!has){setParseError(true);return}
    setParseError(false)
    dbSet("reportData", p)
    setInputOpen(false); setPasteText("")
  }

  // Excel一括更新
  const handleXlsxUpload = async(file) => {
    setXlsxImporting(true); setXlsxError(""); setXlsxResult(null)
    try{ const r=await parseExcelFile(file); setXlsxResult(r) }
    catch(e){ setXlsxError("読み込みエラー: "+e.message) }
    setXlsxImporting(false)
  }
  const applyXlsx = () => {
    if(!xlsxResult) return
    if(xlsxResult.products){ dbSet("products", xlsxResult.products) }
    if(xlsxResult.eventProducts){ dbSet("eventProducts", xlsxResult.eventProducts) }
    setXlsxResult(null)
  }

  // 店舗一括登録
  const handleStoreImport = async(file) => {
    setStoreImporting(true); setStoreImportError(""); setStoreImportResult(null)
    try{
      const r=await parseStoreFile(file)
      if(!r||r.length===0) setStoreImportError("店舗データが見つかりません")
      else setStoreImportResult(r)
    }catch(e){ setStoreImportError("読み込みエラー: "+e.message) }
    setStoreImporting(false)
  }
  const applyStoreImport = () => {
    if(!storeImportResult) return
    dbSet("stores", storeImportResult)
    setStoreImportResult(null)
  }

  // Excel出力
  const exportExcel = () => {
    const rows=[["番号","エリア","店舗名","ランク","物流","納品時間","出荷日","ケース数（619）","備考"]]
    stores.forEach(s=>{const r=shipReport[s.id]||{};rows.push([s.id,s.area,s.name,s.rank,s.logistics,s.time,shipDate,r.caseCount,r.note])})
    const ws=XLSX.utils.aoa_to_sheet(rows); ws["!cols"]=[6,10,20,6,8,12,12,14,20].map(w=>({wch:w}))
    const wb2=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb2,ws,"出荷報告")
    XLSX.writeFile(wb2,`出荷報告_${now.toISOString().slice(0,10)}.xlsx`)
  }

  // 算出値
  const rd = reportData
  const hotSet = rd ? new Set((rd.prodSales||[]).map(p=>p.name.replace(/\s/g,""))) : new Set()
  const isHot  = name => [...hotSet].some(h=>name.replace(/\s/g,"").includes(h)||h.includes(name.replace(/\s/g,"")))
  const filtProducts = catFilter==="全品目" ? products : products.filter(p=>p.cat===catFilter)
  const filtStores   = area==="全エリア" ? stores : stores.filter(s=>s.area===area)

  const timeStr = now.toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit",second:"2-digit"})
  const dateStr = now.toLocaleDateString("ja-JP",{year:"numeric",month:"long",day:"numeric",weekday:"short"})

  const TABS=[
    {id:"dashboard",label:"ダッシュボード",icon:"🏠"},{id:"sales",label:"売上",icon:"📊"},
    {id:"shelf",label:"棚割表",icon:"📋"},{id:"event",label:"催事",icon:"🎯"},
    {id:"stores",label:"店舗・ピッキング",icon:"🏪"},{id:"stock",label:"センター在庫",icon:"🏭"},
    {id:"reports",label:"週次報告",icon:"📝"},{id:"admin",label:"管理者",icon:"⚙️"},
  ]

  const Btn=({children,onClick,style={},color=accent,outline=false})=>(
    <button onClick={onClick} style={{padding:"9px 18px",background:outline?"#fff":color,border:`2px solid ${outline?color:"transparent"}`,borderRadius:10,color:outline?color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:7,...style}}>
      {children}
    </button>
  )

  // DB未接続中はスプラッシュ表示
  if(!dbReady) return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",background:"#f0f4f0",gap:16}}>
      <div style={{fontSize:32,fontWeight:900,color:"#4a7c59",letterSpacing:4,fontFamily:"monospace"}}>OTOKAWA</div>
      <div style={{fontSize:14,color:"#6b7280"}}>接続中…</div>
      <div style={{width:48,height:4,borderRadius:2,background:"#dcfce7",overflow:"hidden",position:"relative"}}>
        <div style={{position:"absolute",inset:0,background:"#4a7c59",animation:"loading 1.2s ease-in-out infinite",borderRadius:2}}/>
      </div>
      <style>{`@keyframes loading{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}`}</style>
    </div>
  )

  return (
    <div style={{background:festive?"#fff5f5":"#f0f4f0",minHeight:"100vh",color:"#1c1c1e",fontFamily:"'Noto Sans JP',sans-serif"}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&family=IBM+Plex+Mono:wght@600;700&display=swap');
        *{box-sizing:border-box;margin:0;padding:0}
        ::-webkit-scrollbar{width:6px}::-webkit-scrollbar-thumb{background:#b0bdb5;border-radius:4px}
        .card{background:#fff;border-radius:16px;box-shadow:0 2px 8px rgba(0,0,0,.06)}
        .fade{animation:fi .2s ease}@keyframes fi{from{opacity:0;transform:translateY(4px)}to{opacity:1}}
        .pulse{animation:pl 2s ease-in-out infinite}@keyframes pl{0%,100%{opacity:1}50%{opacity:.3}}
        .ov{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:60;display:flex;align-items:center;justify-content:center}
        .modal{background:#fff;border-radius:20px;padding:28px;width:94%;max-width:640px;max-height:90vh;overflow-y:auto;box-shadow:0 24px 64px rgba(0,0,0,.18)}
        input,select,textarea{background:#f4f6f4;border:1.5px solid #dde5de;color:#1c1c1e;border-radius:10px;padding:9px 13px;font-size:14px;font-family:'Noto Sans JP',sans-serif;width:100%;outline:none}
        input:focus,select:focus,textarea:focus{border-color:${accent};background:#fff}
        .hot{font-size:11px;background:#d97706;color:#fff;padding:2px 7px;border-radius:4px;font-weight:700}
        ${festive?"@keyframes festive{0%,100%{background-position:0% 50%}50%{background-position:100% 50%}}.festive-banner{background:linear-gradient(90deg,#dc2626,#ef4444,#f97316,#ef4444,#dc2626);background-size:200%;animation:festive 3s ease infinite;color:#fff;text-align:center;padding:10px;font-weight:900;font-size:14px;letter-spacing:2px}":""}
      `}</style>

      {festive && <div className="festive-banner">🎉 本日はツルハの日！ 毎月1・10・20日 🎉</div>}

      {/* ヘッダー */}
      <div style={{background:festive?"#fff5f5":"#fff",position:"sticky",top:0,zIndex:50,boxShadow:"0 2px 8px rgba(0,0,0,.08)",borderBottom:`2px solid ${festive?"#fca5a5":"#4a7c59"}`}}>
        <div style={{padding:"12px 18px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
          <div>
            <div style={{fontSize:22,fontWeight:900,color:festive?"#dc2626":"#4a7c59",letterSpacing:3,fontFamily:"'IBM Plex Mono',monospace",lineHeight:1.1}}>OTOKAWA</div>
            <div style={{fontSize:11,color:"#6b7280",marginTop:3}}>ツルハドラッグ　青果事業　統合管理</div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:"#22c55e",boxShadow:"0 0 6px #22c55e",flexShrink:0}}/>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:22,fontWeight:800,color:festive?"#dc2626":"#4a7c59",fontFamily:"'IBM Plex Mono',monospace",letterSpacing:1}}>{timeStr}</div>
              <div style={{fontSize:11,color:"#6b7280",marginTop:1}}>{dateStr}</div>
            </div>
          </div>
        </div>
        {tickerItems.length>0 && (
          <div style={{background:festive?"#dc2626":"#4a7c59",padding:"9px 18px",display:"flex",alignItems:"center",gap:12}}>
            <div style={{display:"flex",alignItems:"center",gap:6,background:"rgba(255,255,255,.2)",borderRadius:20,padding:"4px 12px",flexShrink:0}}>
              <span style={{width:7,height:7,borderRadius:"50%",background:"#fff",display:"inline-block"}}/>
              <span style={{fontSize:12,fontWeight:900,color:"#fff",letterSpacing:2,fontFamily:"'IBM Plex Mono',monospace"}}>LIVE</span>
            </div>
            <span style={{fontSize:16,flexShrink:0}}>{tickerItems[tickerIdx]?.icon}</span>
            <span style={{fontSize:14,fontWeight:700,color:"#fff",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1}}>{tickerItems[tickerIdx]?.msg}</span>
            <span style={{fontSize:12,color:"rgba(255,255,255,.75)",flexShrink:0,fontFamily:"'IBM Plex Mono',monospace"}}>{now.getHours().toString().padStart(2,"0")}:{now.getMinutes().toString().padStart(2,"0")}</span>
          </div>
        )}
      </div>

      {/* タブ */}
      <div style={{background:"#fff",borderBottom:"2px solid #eef0ee",padding:"0 16px",display:"flex",gap:2,overflowX:"auto"}}>
        {TABS.map(t=>(
          <button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"13px 14px",background:"none",border:"none",borderBottom:`3px solid ${tab===t.id?accent:"transparent"}`,color:tab===t.id?accent:"#6b7280",fontSize:13,fontWeight:tab===t.id?800:500,cursor:"pointer",whiteSpace:"nowrap",display:"flex",alignItems:"center",gap:5}}>
            <span>{t.icon}</span><span>{t.label}</span>
          </button>
        ))}
      </div>

      {/* コンテンツ */}
      <div style={{padding:"20px 18px 80px",maxWidth:1400,margin:"0 auto"}} className="fade" key={tab}>

        {/* ── ダッシュボード */}
        {tab==="dashboard" && (
          <div style={{display:"grid",gap:18}}>
            {!rd ? (
              <div className="card" style={{padding:48,textAlign:"center",border:"2px dashed #dde5de"}}>
                <div style={{fontSize:40,marginBottom:12}}>📋</div>
                <div style={{fontSize:18,fontWeight:800,marginBottom:8}}>レポート未入力</div>
                <div style={{fontSize:14,color:"#6b7280",marginBottom:20}}>LINEワークスのレポートをコピペして自動反映</div>
                <Btn onClick={()=>setInputOpen(true)} style={{margin:"0 auto"}}>📥 レポートを入力する</Btn>
              </div>
            ) : (
              <>
                <div style={{display:"flex",justifyContent:"space-between",flexWrap:"wrap",gap:12}}>
                  <div>
                    <h2 style={{fontSize:20,fontWeight:900}}>📊 売上ダッシュボード</h2>
                    <div style={{fontSize:13,color:"#6b7280",marginTop:4}}>期間: {rd.period}</div>
                  </div>
                  <Btn onClick={()=>setInputOpen(true)} outline color={accent} style={{padding:"7px 16px"}}>🔄 更新</Btn>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:11}}>
                  {[{l:"総売上",v:fmtJP(rd.totalSales),c:"#16a34a"},{l:"総数量",v:`${(rd.totalQty||0).toLocaleString()}点`,c:"#2563eb"},{l:"平均単価",v:`${Math.round(rd.avgPrice||0)}円`,c:"#7c3aed"},{l:"出店数",v:`${(rd.storeRanking||[]).length}店`,c:accent}].map(k=>(
                    <div key={k.l} className="card" style={{padding:16}}>
                      <div style={{fontSize:12,color:"#6b7280",marginBottom:5}}>{k.l}</div>
                      <div style={{fontSize:22,fontWeight:900,color:k.c,fontFamily:"'IBM Plex Mono',monospace"}}>{k.v}</div>
                    </div>
                  ))}
                </div>
                {(rd.storeRanking||[]).length>0 && (
                  <div className="card" style={{padding:20}}>
                    <div style={{fontSize:15,fontWeight:800,marginBottom:14}}>🏬 店舗別売上</div>
                    {rd.storeRanking.slice(0,10).map((s,i)=>(
                      <div key={i} style={{display:"grid",gridTemplateColumns:"26px 1fr 110px 50px",alignItems:"center",gap:10,marginBottom:10}}>
                        <div style={{fontSize:13,fontWeight:900,textAlign:"center",color:i===0?"#d97706":i===1?"#6b7280":i===2?"#b45309":"#d1d5db"}}>{i+1}</div>
                        <div>
                          <div style={{fontSize:14,fontWeight:600}}>{s.name}</div>
                          <div style={{height:5,background:"#f0f0f0",borderRadius:3,marginTop:4,overflow:"hidden"}}>
                            <div style={{height:"100%",width:`${Math.round((s.sales/(rd.storeRanking[0].sales||1))*100)}%`,background:i===0?"#d97706":accent,borderRadius:3}}/>
                          </div>
                        </div>
                        <div style={{fontSize:14,fontWeight:800,color:"#2563eb",textAlign:"right",fontFamily:"'IBM Plex Mono',monospace"}}>{fmtJP(s.sales)}</div>
                        <div style={{fontSize:12,color:"#6b7280",textAlign:"right"}}>{s.pct}%</div>
                      </div>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* ── 売上 */}
        {tab==="sales" && (
          <div style={{display:"grid",gap:18}}>
            <h2 style={{fontSize:20,fontWeight:900}}>売上ランキング {rd&&<span style={{fontSize:14,fontWeight:400,color:"#6b7280"}}>{rd.period}</span>}</h2>
            {rd&&(rd.storeRanking||[]).length>0 ? (
              <div className="card" style={{padding:22}}>
                <div style={{fontSize:15,fontWeight:800,marginBottom:14}}>🏬 店舗別</div>
                {rd.storeRanking.map((s,i)=>(
                  <div key={i} style={{display:"grid",gridTemplateColumns:"26px 200px 1fr 110px 48px",alignItems:"center",gap:12,marginBottom:11}}>
                    <div style={{fontSize:14,fontWeight:900,textAlign:"center",color:i===0?"#d97706":i===1?"#6b7280":i===2?"#b45309":"#d1d5db"}}>{i+1}</div>
                    <div style={{fontSize:14,fontWeight:600}}>{s.name}</div>
                    <div style={{height:18,background:"#f0f0f0",borderRadius:5,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${Math.round((s.sales/(rd.storeRanking[0].sales||1))*100)}%`,background:i===0?"#d97706":accent,borderRadius:5}}/>
                    </div>
                    <div style={{fontSize:14,fontWeight:800,color:"#2563eb",textAlign:"right",fontFamily:"'IBM Plex Mono',monospace"}}>{fmtJP(s.sales)}</div>
                    <div style={{fontSize:12,color:"#6b7280",textAlign:"right"}}>{s.pct}%</div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="card" style={{padding:48,textAlign:"center"}}>
                <div style={{fontSize:36,marginBottom:14}}>📥</div>
                <div style={{fontSize:15,color:"#6b7280"}}>ダッシュボードからレポートを入力してください</div>
              </div>
            )}
          </div>
        )}

        {/* ── 棚割表 */}
        {tab==="shelf" && (
          <div style={{display:"grid",gap:18}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
              <div>
                <h2 style={{fontSize:20,fontWeight:900}}>棚割表 — レギュラー売り場</h2>
                <div style={{fontSize:13,color:"#6b7280",marginTop:4}}>{products.length}品目</div>
              </div>
              <Btn onClick={()=>setShelfEdit(!shelfEdit)} outline={!shelfEdit} color={shelfEdit?"#dc2626":accent} style={{padding:"7px 16px"}}>{shelfEdit?"✅ 編集終了":"✏️ 編集モード"}</Btn>
            </div>
            <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
              {["全品目",...CATS].map(c=>{
                const cs=CAT[c]; const active=catFilter===c
                return <button key={c} onClick={()=>setCatFilter(c)} style={{padding:"6px 13px",borderRadius:20,fontSize:13,fontWeight:600,border:"2px solid",borderColor:active?(cs?.bd||accent):"#dde5de",background:active?(cs?.bg||accentL):"#fff",color:active?(cs?.tx||"#166534"):"#4a5568"}}>{c}</button>
              })}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(265px,1fr))",gap:12}}>
              {filtProducts.map(p=>{
                const cs=CAT[p.cat]||{bg:"#f5f5f7",tx:"#3c3c43",bd:"#e5e5ea"}
                const mgn=gpN(p.price,p.cost), warn=p.makeQty===0, hot=rd&&isHot(p.name)
                const disc=DISCOUNT_DAYS[p.name], dVal=displayDates[p.id]||""
                const csVal=centerStock[p.id]||"", csNum=parseInt(csVal)
                const csZero=csVal!==""&&!isNaN(csNum)&&csNum===0, csLow=!isNaN(csNum)&&csNum>0&&csNum<10
                let elapsed=null
                if(dVal){const diff=Date.now()-new Date(dVal).getTime();elapsed=Math.floor(diff/(1000*60*60*24))}
                const needsMarkdown=disc&&elapsed!==null&&elapsed>=disc.days
                return (
                  <div key={p.id} className="card" style={{padding:16,border:`2px solid ${csZero?"#dc2626":warn?"#fca5a5":"transparent"}`}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:9}}>
                      <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                        <span style={{fontSize:12,fontWeight:700,background:cs.bg,color:cs.tx,padding:"3px 8px",borderRadius:5}}>{p.rack}</span>
                        {hot && <span className="hot">🔥HOT</span>}
                        {warn && <span style={{fontSize:11,background:"#fee2e2",color:"#dc2626",padding:"2px 6px",borderRadius:4,fontWeight:700}}>作成数0</span>}
                        {csZero && <span style={{fontSize:11,background:"#dc2626",color:"#fff",padding:"2px 6px",borderRadius:4,fontWeight:700}} className="pulse">⚠️在庫0</span>}
                        {csLow && <span style={{fontSize:11,background:"#fef9c3",color:"#854d0e",padding:"2px 6px",borderRadius:4,fontWeight:700}}>残少</span>}
                      </div>
                      <span style={{fontSize:11,color:"#6b7280"}}>{p.cat}</span>
                    </div>
                    <div style={{fontSize:15,fontWeight:800,marginBottom:3}}>{p.name}</div>
                    <div style={{fontSize:12,color:"#6b7280",marginBottom:9}}>産地: {p.origin}</div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:5,marginBottom:9,fontSize:12}}>
                      {[["売価",fmt(p.price),null],["粗利率",`${mgn}%`,mgn>=35?"#16a34a":mgn>=25?"#d97706":"#dc2626"],["作成数",String(p.makeQty),warn?"#dc2626":"#2563eb"]].map(([l,v,c])=>(
                        <div key={l} style={{background:"#f4f6f4",borderRadius:7,padding:"6px 7px",textAlign:"center"}}>
                          <div style={{color:"#6b7280"}}>{l}</div>
                          <div style={{fontWeight:800,color:c||undefined,fontFamily:"'IBM Plex Mono',monospace"}}>{v}</div>
                        </div>
                      ))}
                    </div>
                    <div style={{background:csZero?"#fee2e2":csLow?"#fef9c3":csVal?"#dcfce7":"#f4f6f4",border:`1.5px solid ${csZero?"#fca5a5":csLow?"#fde047":csVal?"#86efac":"#dde5de"}`,borderRadius:8,padding:"7px 11px",marginBottom:7,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontSize:12,color:"#6b7280"}}>📦 センター在庫</span>
                      <span style={{fontSize:20,fontWeight:900,color:csZero?"#dc2626":csLow?"#d97706":"#166534",fontFamily:"'IBM Plex Mono',monospace"}}>{csVal||"―"}</span>
                    </div>
                    {shelfEdit && (
                      <div style={{display:"grid",gap:6,marginTop:7}}>
                        <div style={{display:"flex",gap:6}}>
                          {[["売価","price",p.price],["原価","cost",p.cost],["作成数","makeQty",p.makeQty]].map(([l,f,v])=>(
                            <div key={f} style={{flex:1}}>
                              <div style={{fontSize:10,color:"#6b7280",marginBottom:2}}>{l}</div>
                              <input type="number" value={v} onChange={e=>updateProduct(p.id,f,e.target.value)} style={{padding:"5px 7px",fontSize:12}}/>
                            </div>
                          ))}
                        </div>
                        <div>
                          <div style={{fontSize:10,color:"#6b7280",marginBottom:2}}>陳列日</div>
                          <input type="date" value={dVal} onChange={e=>updateDisplayDate(p.id,e.target.value)} style={{padding:"5px 7px",fontSize:12}}/>
                        </div>
                      </div>
                    )}
                    {elapsed!==null && disc && (
                      <div style={{marginTop:7,background:needsMarkdown?"#fee2e2":"#f0fdf4",border:`1px solid ${needsMarkdown?"#fca5a5":"#86efac"}`,borderRadius:8,padding:"6px 9px",fontSize:12}}>
                        <span style={{color:needsMarkdown?"#dc2626":"#166534",fontWeight:700}}>{needsMarkdown?"⚠️半額検討 ":"✅"}{elapsed}日目/{disc.days}日まで</span>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── 催事 */}
        {tab==="event" && (
          <div style={{display:"grid",gap:18}}>
            <div>
              <h2 style={{fontSize:20,fontWeight:900}}>ツルハ催事ラインナップ</h2>
              <div style={{fontSize:13,color:"#6b7280",marginTop:4}}>コンテナ統一: <strong>619番</strong> ／ {eventProducts.length}品目</div>
            </div>
            <div style={{background:"#fef9c3",border:"2px solid #fde047",borderRadius:12,padding:"15px 18px",display:"flex",gap:22,flexWrap:"wrap"}}>
              {[["📦","コンテナ","619番"],["🎯","品目数",`${eventProducts.length}品`],["🔢","総数量",`${eventProducts.reduce((a,b)=>a+(Number(b.qty)||0),0)}個`],["💴","作成売上",fmtJP(eventProducts.reduce((a,b)=>a+(Number(b.price)||0)*(Number(b.qty)||0),0))]].map(([ic,l,v])=>(
                <div key={l} style={{display:"flex",alignItems:"center",gap:9}}>
                  <span style={{fontSize:22}}>{ic}</span>
                  <div><div style={{fontSize:11,color:"#854d0e"}}>{l}</div><div style={{fontSize:16,fontWeight:900,color:"#854d0e",fontFamily:"'IBM Plex Mono',monospace"}}>{v}</div></div>
                </div>
              ))}
            </div>
            <div className="card" style={{overflow:"hidden"}}>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:14}}>
                  <thead><tr style={{background:"#f4f6f4"}}>
                    {["#","品目","売価","原価","粗利率","数量","作成売上"].map(h=>(
                      <th key={h} style={{padding:"11px 13px",textAlign:"left",color:"#6b7280",fontWeight:700,whiteSpace:"nowrap",borderBottom:"2px solid #eef0ee"}}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {eventProducts.map((p,i)=>{
                      const price=Number(p.price)||0, cost=Number(p.cost)||0, qty=Number(p.qty)||0, mgn=gpN(price,cost)
                      return (
                        <tr key={p.id||i} style={{borderBottom:"1px solid #f0f0f0"}}>
                          <td style={{padding:"10px 13px",color:"#c7c7cc",fontWeight:700}}>{p.num||i+1}</td>
                          <td style={{padding:"10px 13px",fontWeight:700}}>{p.name}{p.note?<span style={{fontSize:11,color:"#d97706",marginLeft:5}}>({p.note})</span>:null}</td>
                          <td style={{padding:"10px 13px",fontFamily:"'IBM Plex Mono',monospace"}}>¥{price}</td>
                          <td style={{padding:"10px 13px",color:"#6b7280",fontFamily:"'IBM Plex Mono',monospace"}}>¥{cost}</td>
                          <td style={{padding:"10px 13px"}}><span style={{fontSize:12,fontWeight:700,padding:"3px 7px",borderRadius:5,background:mgn>=40?"#dcfce7":mgn>=25?"#fef9c3":"#fee2e2",color:mgn>=40?"#16a34a":mgn>=25?"#d97706":"#dc2626"}}>{mgn}%</span></td>
                          <td style={{padding:"10px 13px",fontWeight:700,color:"#2563eb",fontFamily:"'IBM Plex Mono',monospace"}}>{qty}</td>
                          <td style={{padding:"10px 13px",fontWeight:800,fontFamily:"'IBM Plex Mono',monospace"}}>{fmtJP(price*qty)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot><tr style={{background:"#f4f6f4",borderTop:"2px solid #dde5de"}}>
                    <td colSpan={5} style={{padding:"11px 13px",fontWeight:800}}>合計</td>
                    <td style={{padding:"11px 13px",fontWeight:800,color:"#2563eb",fontFamily:"'IBM Plex Mono',monospace"}}>{eventProducts.reduce((a,b)=>a+(Number(b.qty)||0),0)}</td>
                    <td style={{padding:"11px 13px",fontWeight:900,color:"#16a34a",fontFamily:"'IBM Plex Mono',monospace"}}>{fmtJP(eventProducts.reduce((a,b)=>a+(Number(b.price)||0)*(Number(b.qty)||0),0))}</td>
                  </tr></tfoot>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ── 店舗・ピッキング */}
        {tab==="stores" && (
          <div style={{display:"grid",gap:18}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
              <div>
                <h2 style={{fontSize:20,fontWeight:900}}>🏪 店舗・ピッキング管理</h2>
                <div style={{fontSize:13,color:"#6b7280",marginTop:4}}>稼働中 {stores.length}店舗</div>
              </div>
              <Btn onClick={exportExcel}>📥 出荷Excel出力</Btn>
            </div>
            <div style={{display:"flex",gap:12,alignItems:"center",flexWrap:"wrap"}}>
              <div style={{display:"flex",alignItems:"center",gap:9,background:"#fff",border:"2px solid #dde5de",borderRadius:11,padding:"9px 14px"}}>
                <span style={{fontSize:13,fontWeight:700,color:"#6b7280"}}>📅 出荷日</span>
                <input type="date" value={shipDate} onChange={e=>setShipDate(e.target.value)} style={{border:"none",background:"transparent",width:"auto",padding:"4px 6px",fontSize:14,fontWeight:700}}/>
              </div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                {AREAS.map(a=>(
                  <button key={a} onClick={()=>setArea(a)} style={{padding:"6px 14px",borderRadius:20,fontSize:13,fontWeight:600,border:"2px solid",borderColor:area===a?accent:"#dde5de",background:area===a?accent:"#fff",color:area===a?"#fff":"#4a5568"}}>{a}</button>
                ))}
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:11}}>
              {filtStores.map(s=>{
                const rs=RANK[s.rank]||{bg:"#f5f5f7",tx:"#6b7280"}
                const sr=shipReport[s.id]||{caseCount:"",note:""}
                const isA=s.rank==="A"
                return (
                  <div key={s.id} className="card" style={{padding:isA?19:15,border:`2px solid ${isA?"#d97706":"#eef0ee"}`,background:isA?"linear-gradient(135deg,#fffbeb,#fff)":"#fff",position:"relative",overflow:"hidden"}}>
                    {isA && <div style={{position:"absolute",top:0,right:0,width:0,height:0,borderStyle:"solid",borderWidth:"0 32px 32px 0",borderColor:"transparent #d97706 transparent transparent"}}/>}
                    {isA && <div style={{position:"absolute",top:4,right:3,color:"#fff",fontSize:9,fontWeight:900}}>A</div>}
                    <div style={{marginBottom:9}}>
                      <div style={{display:"flex",gap:5,marginBottom:5,flexWrap:"wrap"}}>
                        <span style={{fontSize:11,fontWeight:700,background:rs.bg,color:rs.tx,padding:"2px 8px",borderRadius:4}}>Rank {s.rank}</span>
                        <span style={{fontSize:11,background:"#f0f4f0",color:"#4a5568",padding:"2px 7px",borderRadius:4}}>{s.area}</span>
                        <span style={{fontSize:11,background:s.logistics==="自社"?"#dcfce7":"#ede9fe",color:s.logistics==="自社"?"#166534":"#5b21b6",padding:"2px 7px",borderRadius:4}}>{s.logistics}</span>
                      </div>
                      <div style={{fontSize:isA?16:14,fontWeight:900,color:isA?"#92400e":"#1c1c1e"}}>{s.name}</div>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginBottom:9,fontSize:11,background:"#f9fafb",borderRadius:7,padding:"8px 10px"}}>
                      <div><span style={{color:"#9ca3af"}}>🕐 </span><strong>{s.time}</strong></div>
                      <div><span style={{color:"#9ca3af"}}>📅 </span><strong>{s.deliveryDays}</strong></div>
                      <div><span style={{color:"#9ca3af"}}>📐 </span><strong>{s.shelfSize}</strong></div>
                      <div><span style={{color:"#9ca3af"}}>🎯 </span><strong>{s.eventSetup||"―"}</strong></div>
                      {s.note&&<div style={{gridColumn:"1/-1",color:"#d97706",fontWeight:700}}>⚠️ {s.note}</div>}
                    </div>
                    <div style={{display:"flex",gap:7,alignItems:"flex-start"}}>
                      <div style={{flex:1}}>
                        <div style={{fontSize:11,color:"#6b7280",marginBottom:2,fontWeight:600}}>備考</div>
                        <input type="text" placeholder="特記事項..." value={sr.note||""} onChange={e=>updateShipReport(s.id,"note",e.target.value)} style={{padding:"6px 9px",fontSize:12}}/>
                      </div>
                      <div>
                        <div style={{fontSize:11,color:"#6b7280",marginBottom:2,fontWeight:600}}>ケース数</div>
                        <input type="number" min="0" placeholder="0" value={sr.caseCount||""} onChange={e=>updateShipReport(s.id,"caseCount",e.target.value)} style={{padding:"6px 8px",fontSize:15,fontWeight:800,textAlign:"center",width:72,border:`2px solid ${isA?"#d97706":"#dde5de"}`}}/>
                      </div>
                    </div>
                    <div style={{marginTop:7,fontSize:11,background:"#ede9fe",color:"#5b21b6",padding:"3px 8px",borderRadius:4,display:"inline-block",fontWeight:700}}>📦 619番</div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── センター在庫 */}
        {tab==="stock" && (
          <div style={{display:"grid",gap:18}}>
            <h2 style={{fontSize:20,fontWeight:900}}>🏭 センター在庫管理</h2>
            <div style={{background:"#dcfce7",border:"1px solid #86efac",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#166534",fontWeight:600}}>
              ✅ 入力した数値は全スタッフのアプリにリアルタイム反映されます
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:11}}>
              {[{l:"入力済み",v:products.filter(p=>centerStock[p.id]!=null&&centerStock[p.id]!=="").length,c:"#16a34a"},{l:"在庫0",v:products.filter(p=>parseInt(centerStock[p.id])===0).length,c:"#dc2626"},{l:"残少(10個未満)",v:products.filter(p=>{const n=parseInt(centerStock[p.id]);return!isNaN(n)&&n>0&&n<10}).length,c:"#d97706"}].map(k=>(
                <div key={k.l} className="card" style={{padding:15,borderLeft:`4px solid ${k.c}`}}>
                  <div style={{fontSize:12,color:"#6b7280",marginBottom:4}}>{k.l}</div>
                  <div style={{fontSize:22,fontWeight:900,color:k.c,fontFamily:"'IBM Plex Mono',monospace"}}>{k.v}<span style={{fontSize:13}}> 品</span></div>
                </div>
              ))}
            </div>
            <div className="card" style={{padding:16}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(255px,1fr))",gap:8}}>
                {products.map(p=>{
                  const cs=CAT[p.cat]||{bg:"#f5f5f7",tx:"#3c3c43"}
                  const val=centerStock[p.id]||"", num=parseInt(val), low=!isNaN(num)&&num>0&&num<10, zero=!isNaN(num)&&num===0
                  return (
                    <div key={p.id} style={{background:zero?"#fee2e2":low?"#fef9c3":"#f4f6f4",border:`1.5px solid ${zero?"#fca5a5":low?"#fde047":"#dde5de"}`,borderRadius:9,padding:"10px 12px",display:"flex",alignItems:"center",gap:9}}>
                      <span style={{fontSize:11,fontWeight:900,background:cs.bg,color:cs.tx,padding:"3px 7px",borderRadius:4,flexShrink:0}}>{p.rack}</span>
                      <div style={{flex:1}}>
                        <div style={{fontSize:13,fontWeight:700}}>{p.name}</div>
                        <div style={{fontSize:11,color:"#6b7280"}}>{p.origin}</div>
                      </div>
                      <input type="number" min="0" placeholder="個" value={val} onChange={e=>updateCenterStock(p.id,e.target.value)} style={{width:68,padding:"5px 7px",textAlign:"center",fontSize:14,fontWeight:800,background:"#fff",border:`1.5px solid ${zero?"#fca5a5":low?"#fde047":"#dde5de"}`}}/>
                    </div>
                  )
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── 週次報告 */}
        {tab==="reports" && (
          <div style={{display:"grid",gap:18}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <h2 style={{fontSize:20,fontWeight:900}}>週次報告</h2>
              <Btn onClick={()=>{setNewReport({date:now.toISOString().slice(0,10),name:"",note:"",storeMsg:""});setReportFormOpen(true)}}>＋ 新規報告</Btn>
            </div>
            <div style={{display:"grid",gap:11}}>
              {weeklyReports.map(r=>(
                <div key={r._key||r.date} className="card" style={{padding:19,border:`2px solid ${r.isNew?"#fca5a5":"#eef0ee"}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:11}}>
                    <div style={{display:"flex",alignItems:"center",gap:9}}>
                      <div style={{width:38,height:38,borderRadius:"50%",background:accentL,display:"flex",alignItems:"center",justifyContent:"center",fontSize:15,fontWeight:900,color:accent,flexShrink:0}}>{(r.name||"？")[0]}</div>
                      <div>
                        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                          <span style={{fontSize:15,fontWeight:800}}>{r.name}</span>
                          {r.isNew && <span style={{fontSize:11,background:"#ef4444",color:"#fff",padding:"2px 7px",borderRadius:4,fontWeight:700}}>NEW</span>}
                          {r.mgRead && <span style={{fontSize:11,background:"#dcfce7",color:"#166534",padding:"2px 7px",borderRadius:4,fontWeight:700}}>✓ MG確認済</span>}
                        </div>
                        <div style={{fontSize:12,color:"#6b7280",marginTop:2}}>{r.date}</div>
                      </div>
                    </div>
                    {!r.mgRead && r._key && (
                      <Btn onClick={()=>markMgRead(r._key)} style={{padding:"5px 12px",fontSize:12}}>✓ MG確認</Btn>
                    )}
                  </div>
                  <div style={{display:"grid",gap:7}}>
                    <div style={{background:"#f4f6f4",borderRadius:8,padding:"11px 13px"}}>
                      <div style={{fontSize:11,color:"#6b7280",fontWeight:600,marginBottom:4}}>📝 気になった点・所感</div>
                      <div style={{fontSize:13,lineHeight:1.8}}>{r.note||"―"}</div>
                    </div>
                    {r.storeMsg && (
                      <div style={{background:"#fef9c3",border:"1px solid #fde047",borderRadius:8,padding:"11px 13px"}}>
                        <div style={{fontSize:11,color:"#854d0e",fontWeight:600,marginBottom:4}}>🏪 店舗からの伝言</div>
                        <div style={{fontSize:13,color:"#854d0e",lineHeight:1.8}}>{r.storeMsg}</div>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── 管理者 */}
        {tab==="admin" && (
          <div style={{display:"grid",gap:18}}>
            <h2 style={{fontSize:20,fontWeight:900}}>⚙️ 管理者パネル</h2>
            <div style={{background:"#dcfce7",border:"1px solid #86efac",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#166534",fontWeight:600}}>
              🔥 Firebase接続済み — すべての変更がリアルタイムで全スタッフに反映されます
            </div>

            <div className="card" style={{padding:20}}>
              <div style={{fontSize:15,fontWeight:800,marginBottom:5}}>📊 棚割・催事 Excel更新</div>
              <div style={{fontSize:13,color:"#6b7280",marginBottom:13}}>ツルハドラッグ.xlsx をアップロード → 全スタッフに即時反映</div>
              <div style={{display:"flex",alignItems:"center",gap:11,flexWrap:"wrap"}}>
                <button onClick={()=>xlsxRef.current?.click()} style={{padding:"9px 20px",background:xlsxImporting?"#f0f4f0":"#2d5a3d",border:"none",borderRadius:9,color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>
                  {xlsxImporting?"⏳ 読込中...":"📊 Excelを読み込む"}
                </button>
                <input ref={xlsxRef} type="file" accept=".xlsx,.xls" style={{display:"none"}} onChange={e=>{if(e.target.files[0])handleXlsxUpload(e.target.files[0]);e.target.value=""}}/>
                {xlsxResult && (
                  <div style={{display:"flex",alignItems:"center",gap:9,flexWrap:"wrap"}}>
                    <span style={{fontSize:13,color:"#166534",fontWeight:600}}>✅ {xlsxResult.products?.length||0}品 / 催事{xlsxResult.eventProducts?.length||0}品</span>
                    <Btn onClick={applyXlsx} style={{padding:"7px 16px"}}>✅ 反映する</Btn>
                    <Btn outline color={accent} onClick={()=>setXlsxResult(null)} style={{padding:"7px 11px"}}>閉じる</Btn>
                  </div>
                )}
              </div>
              {xlsxError && <div style={{marginTop:9,background:"#fee2e2",borderRadius:7,padding:"7px 11px",fontSize:13,color:"#dc2626"}}>⚠️ {xlsxError}</div>}
            </div>

            <div className="card" style={{padding:20}}>
              <div style={{fontSize:15,fontWeight:800,marginBottom:5}}>🏪 店舗情報 一括登録</div>
              <div style={{fontSize:13,color:"#6b7280",marginBottom:13}}>店舗詳細シート（.xlsx）をアップロード</div>
              <div style={{display:"flex",alignItems:"center",gap:11,flexWrap:"wrap"}}>
                <button onClick={()=>storeRef.current?.click()} style={{padding:"9px 20px",background:storeImporting?"#f0f4f0":"#1e40af",border:"none",borderRadius:9,color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>
                  {storeImporting?"⏳ 読込中...":"🏪 店舗Excelを読み込む"}
                </button>
                <input ref={storeRef} type="file" accept=".xlsx,.xls" style={{display:"none"}} onChange={e=>{if(e.target.files[0])handleStoreImport(e.target.files[0]);e.target.value=""}}/>
                {storeImportResult && (
                  <div style={{display:"flex",alignItems:"center",gap:9,flexWrap:"wrap"}}>
                    <span style={{fontSize:13,color:"#166534",fontWeight:600}}>✅ {storeImportResult.length}店舗</span>
                    <Btn onClick={applyStoreImport} style={{padding:"7px 16px"}}>✅ 反映する</Btn>
                    <Btn outline color={accent} onClick={()=>setStoreImportResult(null)} style={{padding:"7px 11px"}}>閉じる</Btn>
                  </div>
                )}
              </div>
              {storeImportError && <div style={{marginTop:9,background:"#fee2e2",borderRadius:7,padding:"7px 11px",fontSize:13,color:"#dc2626"}}>⚠️ {storeImportError}</div>}
            </div>

            <div className="card" style={{padding:20}}>
              <div style={{fontSize:15,fontWeight:800,marginBottom:13}}>📢 LIVEティッカー管理</div>
              <div style={{display:"grid",gap:6,marginBottom:11}}>
                {tickerItems.map((t,i)=>(
                  <div key={i} style={{display:"flex",alignItems:"center",gap:7,background:"#f4f6f4",borderRadius:8,padding:"8px 11px"}}>
                    <input value={t.icon} onChange={e=>updateTickerItem(i,"icon",e.target.value)} style={{width:42,textAlign:"center",fontSize:16,padding:"4px"}}/>
                    <input value={t.msg} onChange={e=>updateTickerItem(i,"msg",e.target.value)} style={{flex:1,fontSize:13}}/>
                    <button onClick={()=>removeTickerItem(i)} style={{padding:"3px 9px",background:"#fee2e2",border:"none",borderRadius:5,fontSize:12,fontWeight:700,color:"#dc2626",cursor:"pointer",flexShrink:0}}>削除</button>
                  </div>
                ))}
              </div>
              <div style={{display:"flex",gap:7,alignItems:"center",padding:"11px 13px",background:"#f0fdf4",borderRadius:9,border:"1.5px solid #86efac"}}>
                <input value={editTIcon} onChange={e=>setEditTIcon(e.target.value)} style={{width:44,textAlign:"center",fontSize:16,padding:"5px"}}/>
                <input value={editTMsg} onChange={e=>setEditTMsg(e.target.value)} placeholder="LIVEメッセージ..." style={{flex:1,fontSize:13}}/>
                <Btn onClick={addTickerItem} style={{padding:"6px 14px",flexShrink:0}}>＋ 追加</Btn>
              </div>
            </div>

            <div className="card" style={{padding:20}}>
              <div style={{fontSize:15,fontWeight:800,marginBottom:11}}>📊 システム情報</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:9}}>
                {[{l:"稼働中店舗",v:`${stores.length}店舗`},{l:"レギュラー品目",v:`${products.length}品`},{l:"催事品目",v:`${eventProducts.length}品`},{l:"週次報告",v:`${weeklyReports.length}件`},{l:"MG未確認",v:`${weeklyReports.filter(r=>!r.mgRead).length}件`,red:weeklyReports.some(r=>!r.mgRead)},{l:"DB同期",v:"LIVE 🟢",green:true}].map(k=>(
                  <div key={k.l} style={{background:"#f4f6f4",borderRadius:9,padding:"12px 14px"}}>
                    <div style={{fontSize:12,color:"#6b7280",marginBottom:3}}>{k.l}</div>
                    <div style={{fontSize:17,fontWeight:900,color:k.red?"#dc2626":k.green?accent:"#1c1c1e",fontFamily:"'IBM Plex Mono',monospace"}}>{k.v}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* レポート入力モーダル */}
      {inputOpen && (
        <div className="ov" onClick={()=>setInputOpen(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:15}}>
              <div style={{fontSize:17,fontWeight:900}}>📥 売上レポート入力</div>
              <button onClick={()=>setInputOpen(false)} style={{background:"none",border:"none",fontSize:22,color:"#8e9e91",cursor:"pointer"}}>✕</button>
            </div>
            <div style={{fontSize:13,color:"#6b7280",marginBottom:9}}>LINEワークスのレポートをコピー＆ペーストしてください</div>
            <textarea value={pasteText} onChange={e=>{setPasteText(e.target.value);setParseError(false)}} rows={10} style={{resize:"vertical",fontSize:13,lineHeight:1.8}} placeholder={"お疲れ様です！\nA) 全体\n対象期間: ...\n総数量: ...\n"}/>
            {parseError && <div style={{background:"#fee2e2",borderRadius:8,padding:"8px 12px",marginTop:9,fontSize:13,color:"#dc2626"}}>⚠️ 解析できませんでした。フォーマットを確認してください。</div>}
            <div style={{display:"flex",gap:9,justifyContent:"flex-end",marginTop:13}}>
              <Btn outline color={accent} onClick={()=>setInputOpen(false)} style={{padding:"7px 15px"}}>キャンセル</Btn>
              <Btn onClick={handleApply} style={{padding:"7px 20px",background:pasteText.length>10?accent:"#c7c7cc"}}>✅ 反映する</Btn>
            </div>
          </div>
        </div>
      )}

      {/* 週次報告フォーム */}
      {reportFormOpen && (
        <div className="ov" onClick={()=>setReportFormOpen(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:15}}>
              <div style={{fontSize:17,fontWeight:900}}>📝 週次報告を作成</div>
              <button onClick={()=>setReportFormOpen(false)} style={{background:"none",border:"none",fontSize:22,color:"#8e9e91",cursor:"pointer"}}>✕</button>
            </div>
            {[["日付","date","date",""],["名前","name","text","例: 助川、神谷..."]].map(([l,f,t,ph])=>(
              <div key={f} style={{marginBottom:12}}>
                <div style={{fontSize:13,fontWeight:600,marginBottom:5}}>{l}</div>
                <input type={t} placeholder={ph} value={newReport[f]} onChange={e=>setNewReport(p=>({...p,[f]:e.target.value}))}/>
              </div>
            ))}
            <div style={{marginBottom:12}}>
              <div style={{fontSize:13,fontWeight:600,marginBottom:5}}>気になった点・所感</div>
              <textarea rows={4} value={newReport.note} onChange={e=>setNewReport(p=>({...p,note:e.target.value}))} placeholder="今週の売場状況、気づいたこと..." style={{resize:"vertical"}}/>
            </div>
            <div style={{marginBottom:16}}>
              <div style={{fontSize:13,fontWeight:600,marginBottom:5}}>店舗からの伝言</div>
              <textarea rows={3} value={newReport.storeMsg} onChange={e=>setNewReport(p=>({...p,storeMsg:e.target.value}))} placeholder="店舗スタッフ・店長からの連絡事項..." style={{resize:"vertical"}}/>
            </div>
            <div style={{display:"flex",gap:9,justifyContent:"flex-end"}}>
              <Btn outline color={accent} onClick={()=>setReportFormOpen(false)} style={{padding:"7px 15px"}}>キャンセル</Btn>
              <Btn onClick={()=>{if(!newReport.name.trim()||!newReport.date)return;addWeeklyReport(newReport);setReportFormOpen(false)}} style={{padding:"7px 20px",background:newReport.name&&newReport.date?accent:"#c7c7cc"}}>提出する</Btn>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
