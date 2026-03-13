
import { useState, useEffect, useRef } from "react"
import * as XLSX from "xlsx"
import { dbSet, dbListen, dbPush, dbGet, initIfEmpty } from "./firebase"
import {
  DISCOUNT_DAYS, INITIAL_PRODUCTS, INITIAL_EVENT, DEFAULT_STORES,
  INITIAL_TICKER, INITIAL_WEEKLY, EVENT_CONTAINER_TARGET,
  CATS, CAT, RANK
} from "./data"


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
            const rack=row[2]?String(row[2]).trim():""; if(!/^[A-Z]\d+$/.test(rack)) return
            const name=row[3]?String(row[3]).trim():""
            const spec=row[5]?String(row[5]).replace(/\u3000/g,"").trim():""
            const origin=String(row[7]||row[6]||"").replace(/\u3000/g,"").trim()
            const price=Number(row[8])||0, cost=Number(row[9])||0
            const displayQty=Number(row[11])||0, makeQty=Number(row[12])||0
            if(!name||!price) return
            prods.push({id:`XL_${ri}`,rack,cat:cat||"根菜",name:(spec?`${name} ${spec}`:name).replace(/\u3000/g,"").trim(),origin,price,cost,displayQty,makeQty})
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
            const evOrigin=row[4]?String(row[4]).replace(/\u3000/g,"").trim():""
            evProds.push({id:`EV_${ri}`,num,name,price,cost,qty,origin:evOrigin,note:""})
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
  return new Promise((resolve,reject)=>{
    const reader=new FileReader()
    reader.onload=(e)=>{
      try{
        const wb=XLSX.read(e.target.result,{type:"binary"})
        const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,defval:null})
        const stores=[]
        rows.forEach((row,ri)=>{
          if(ri<2) return
          if(String(row[0]||"").trim()!=="済") return
          const rank=row[4]?String(row[4]).trim():""; if(!rank) return
          const id=Number(row[1])||ri, area=row[2]?String(row[2]).trim():""
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

export default function App() {
  const festive = isTsuruhaDay()
  const accent  = festive ? "#dc2626" : "#4a7c59"
  const accentL = festive ? "#fee2e2" : "#dcfce7"

  const [now,setNow] = useState(new Date())
  useEffect(()=>{const t=setInterval(()=>setNow(new Date()),1000);return()=>clearInterval(t)},[])

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
  const [finalizeConfirm,setFinalizeConfirm] = useState(false)
  const [discountDayOverrides,setDiscountDayOverrides] = useState({})
  const [boardMessages,setBoardMessages] = useState({board_all:"",board_cmg:"",board_smg:""})
  const [boardDate,setBoardDate]         = useState(new Date().toISOString().slice(0,10))
  const [boardUpdated,setBoardUpdated]   = useState({})
  const [pickingDone,setPickingDone]     = useState({})  // {storeId: true/false}
  const [pickingDayFilter,setPickingDayFilter] = useState("auto") // "auto"|"全体"|"月"|"火"|"水"|"木"|"金"|"土"|"日"

  const [showAddEvent,setShowAddEvent]     = useState(false)
  const [newEventItem,setNewEventItem]     = useState({name:"",price:"",cost:"",qty:"",origin:"",note:""})

  // Firebase同期 state
  const [products,setProducts]           = useState(INITIAL_PRODUCTS)
  const [eventProducts,setEventProducts] = useState(INITIAL_EVENT)
  const [stores,setStores]               = useState(DEFAULT_STORES)
  const [shipDate,setShipDateState]      = useState(new Date().toISOString().slice(0,10))
  const [shipReport,setShipReport]       = useState({})
  const [centerStock,setCenterStock]     = useState({})
  const [displayDates,setDisplayDates]   = useState({})
  const [actualMakeQty,setActualMakeQty] = useState({}) // レギュラー実作成数
  const [eventStatus,setEventStatus]     = useState({}) // 催事品目ごとの状態 {actualMade, status:'pending'|'done'|'shortage'}
  const [packageFinalized,setPackageFinalized] = useState(null) // 催事最終確認
  const [regularStatus,setRegularStatus] = useState({}) // レギュラー品目ごとの状態
  const [regularFinalized,setRegularFinalized] = useState(null) // レギュラー最終確認
  const [regularFinalizeConfirm,setRegularFinalizeConfirm] = useState(false)
  const [weeklyReports,setWeeklyReports] = useState([])
  const [tickerItems,setTickerItems]     = useState(INITIAL_TICKER)
  const [reportData,setReportData]       = useState(null)

  const xlsxRef  = useRef()
  const storeRef = useRef()
  const debounceRef = useRef({})

  const debouncedWrite = (path, val, delay=600) => {
    if(debounceRef.current[path]) clearTimeout(debounceRef.current[path])
    debounceRef.current[path] = setTimeout(()=>{ dbSet(path, val) }, delay)
  }

  useEffect(()=>{
    const init = async () => {
      await initIfEmpty("products", INITIAL_PRODUCTS)
      await initIfEmpty("eventProducts", INITIAL_EVENT)
      await initIfEmpty("stores", DEFAULT_STORES)
      await initIfEmpty("shipDate", new Date().toISOString().slice(0,10))
      await initIfEmpty("shipReport", {})
      await initIfEmpty("centerStock", {})
      await initIfEmpty("displayDates", {})
      await initIfEmpty("actualMakeQty", {})
      await initIfEmpty("eventStatus", {})
      await initIfEmpty("tickerItems", INITIAL_TICKER)
      await initIfEmpty("boardMessages", {board_all:"",board_cmg:"",board_smg:""})
      await initIfEmpty("boardDate", new Date().toISOString().slice(0,10))
      await initIfEmpty("regularStatus", {})
      await initIfEmpty("regularFinalized", null)
      await initIfEmpty("pickingDone", {})
      const snap = await dbGet("weeklyReports")
      if(!snap.exists()){ for(const r of INITIAL_WEEKLY){ await dbPush("weeklyReports", r) } }
      setDbReady(true)
    }
    init()
  },[])

  useEffect(()=>{
    if(!dbReady) return
    const unsubs = [
      dbListen("products",         v => v && setProducts(Array.isArray(v)?v:Object.values(v))),
      dbListen("eventProducts",    v => v && setEventProducts(Array.isArray(v)?v:Object.values(v))),
      dbListen("stores",           v => v && setStores(Array.isArray(v)?v:Object.values(v))),
      dbListen("shipDate",         v => v && setShipDateState(v)),
      dbListen("shipReport",       v => setShipReport(v||{})),
      dbListen("centerStock",      v => setCenterStock(v||{})),
      dbListen("displayDates",     v => setDisplayDates(v||{})),
      dbListen("actualMakeQty",    v => setActualMakeQty(v||{})),
      dbListen("eventStatus",      v => setEventStatus(v||{})),
      dbListen("packageFinalized", v => setPackageFinalized(v||null)),
      dbListen("tickerItems",      v => v && setTickerItems(Array.isArray(v)?v:Object.values(v))),
      dbListen("reportData",       v => setReportData(v||null)),
      dbListen("boardMessages",    v => v && setBoardMessages(v)),
      dbListen("boardDate",        v => v && setBoardDate(v)),
      dbListen("regularStatus",    v => setRegularStatus(v||{})),
      dbListen("regularFinalized", v => setRegularFinalized(v||null)),
      dbListen("pickingDone",      v => setPickingDone(v||{})),
      dbListen("weeklyReports",    v => {
        if(!v) return
        const arr=Object.entries(v).map(([k,r])=>({...r,_key:k}))
        arr.sort((a,b)=>new Date(b.date)-new Date(a.date))
        setWeeklyReports(arr)
      }),
    ]
    return () => unsubs.forEach(u=>u())
  },[dbReady])

  useEffect(()=>{
    if(!tickerItems.length) return
    const t=setInterval(()=>setTickerIdx(x=>(x+1)%tickerItems.length),4000)
    return()=>clearInterval(t)
  },[tickerItems.length])

  // ── 書き込み関数
  const setShipDate = (v) => { setShipDateState(v); dbSet("shipDate",v) }
  const updateShipReport = (sid,field,val) => {
    const next={...(shipReport[sid]||{}),[field]:val}
    setShipReport(p=>({...p,[sid]:next})); debouncedWrite(`shipReport/${sid}`,next)
  }
  const updateCenterStock = (pid,val) => {
    setCenterStock(p=>({...p,[pid]:val})); debouncedWrite(`centerStock/${pid}`,val)
  }
  const updateDisplayDate = (pid,val) => {
    setDisplayDates(p=>({...p,[pid]:val})); debouncedWrite(`displayDates/${pid}`,val)
  }
  const updateActualMakeQty = (pid,val) => {
    setActualMakeQty(p=>({...p,[pid]:val})); debouncedWrite(`actualMakeQty/${pid}`,val)
  }
  const updateProduct = (id,field,val) => {
    const next=products.map(p=>p.id===id?{...p,[field]:["price","cost","makeQty","displayQty"].includes(field)?Number(val)||0:val}:p)
    setProducts(next); debouncedWrite("products",next,1000)
  }
  const updateEventStatus = (eid,field,val) => {
    const next={...(eventStatus[eid]||{}),[field]:val}
    setEventStatus(p=>({...p,[eid]:next})); debouncedWrite(`eventStatus/${eid}`,next)
  }
  const updateRegularStatus = (pid,field,val) => {
    const next={...(regularStatus[pid]||{}),[field]:val}
    setRegularStatus(p=>({...p,[pid]:next})); debouncedWrite(`regularStatus/${pid}`,next)
  }
  const finalizeRegular = () => {
    const ts=new Date().toISOString()
    dbSet("regularFinalized",ts); setRegularFinalized(ts); setRegularFinalizeConfirm(false)
  }
  const resetRegular = () => { dbSet("regularFinalized",null); dbSet("regularStatus",{}); setRegularFinalized(null); setRegularStatus({}) }
  const addEventProduct = () => {
    if(!newEventItem.name.trim()||!newEventItem.price) return
    const maxNum = eventProducts.reduce((m,p)=>Math.max(m,p.num||0),0)
    const newProd = {
      id:`EV_custom_${Date.now()}`,
      num: maxNum+1,
      name: newEventItem.name.trim(),
      price: Number(newEventItem.price)||0,
      cost: Number(newEventItem.cost)||0,
      qty: Number(newEventItem.qty)||0,
      origin: newEventItem.origin.trim(),
      note: newEventItem.note.trim()
    }
    setEventProducts(prev=>{const next=[...prev,newProd];dbSet("eventProducts",next);return next})
    setNewEventItem({name:"",price:"",cost:"",qty:"",origin:"",note:""})
    setShowAddEvent(false)
  }
  const finalizePackage = () => {
    const ts=new Date().toISOString()
    dbSet("packageFinalized",ts); setPackageFinalized(ts); setFinalizeConfirm(false)
  }
  const resetPackage = () => {
    dbSet("packageFinalized",null)
    dbSet("eventStatus",{})
    setPackageFinalized(null); setEventStatus({})
  }
  const addWeeklyReport = (r) => dbPush("weeklyReports",{...r,isNew:true,mgRead:false,createdAt:Date.now()})
  const markMgRead = (key) => { dbSet(`weeklyReports/${key}/mgRead`,true); dbSet(`weeklyReports/${key}/isNew`,false) }
  const addTickerItem = () => {
    if(!editTMsg.trim()) return
    dbSet("tickerItems",[...tickerItems,{icon:editTIcon,msg:editTMsg.trim()}])
    setEditTMsg(""); setEditTIcon("📢")
  }
  const removeTickerItem = (i) => dbSet("tickerItems",tickerItems.filter((_,idx)=>idx!==i))
  const updateTickerItem = (i,field,val) => {
    const next=tickerItems.map((t,idx)=>idx===i?{...t,[field]:val}:t)
    setTickerItems(next); debouncedWrite("tickerItems",next,800)
  }
  const handleApply = () => {
    const p=parseReport(pasteText)
    if(!p||(!(p.totalSales>0)&&!(p.totalQty>0)&&!(p.storeRanking||[]).length)){setParseError(true);return}
    setParseError(false); dbSet("reportData",p); setInputOpen(false); setPasteText("")
  }
  const handleXlsxUpload = async(file) => {
    setXlsxImporting(true); setXlsxError(""); setXlsxResult(null)
    try{setXlsxResult(await parseExcelFile(file))}catch(e){setXlsxError("読み込みエラー: "+e.message)}
    setXlsxImporting(false)
  }
  const applyXlsx = () => {
    if(!xlsxResult) return
    if(xlsxResult.products) dbSet("products",xlsxResult.products)
    if(xlsxResult.eventProducts) dbSet("eventProducts",xlsxResult.eventProducts)
    setXlsxResult(null)
  }
  const handleStoreImport = async(file) => {
    setStoreImporting(true); setStoreImportError(""); setStoreImportResult(null)
    try{
      const r=await parseStoreFile(file)
      if(!r||!r.length) setStoreImportError("店舗データが見つかりません")
      else setStoreImportResult(r)
    }catch(e){setStoreImportError("読み込みエラー: "+e.message)}
    setStoreImporting(false)
  }
  const applyStoreImport = () => { if(!storeImportResult) return; dbSet("stores",storeImportResult); setStoreImportResult(null) }

  // Excel出力
  const exportShipExcel = () => {
    const rows=[["番号","エリア","店舗名","ランク","物流","配送曜日","納品時間","出荷日","ケース数（619）","備考"]]
    stores.forEach(s=>{const r=shipReport[s.id]||{};rows.push([s.id,s.area,s.name,s.rank,s.logistics,s.deliveryDays,s.time,shipDate,r.caseCount,r.note])})
    const ws=XLSX.utils.aoa_to_sheet(rows); ws["!cols"]=[6,8,18,5,7,10,10,12,12,20].map(w=>({wch:w}))
    const wb2=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb2,ws,"出荷報告")
    XLSX.writeFile(wb2,`出荷報告_${now.toISOString().slice(0,10)}.xlsx`)
  }

  const exportMakeQtyExcel = () => {
    const rows=[["ラック","品目","産地","計画作成数","実際の作成数","差異"]]
    products.forEach(p=>{
      const planned=p.makeQty||0, actual=Number(actualMakeQty[p.id])||0
      rows.push([p.rack,p.name,p.origin,planned,actual||"未入力",actual?actual-planned:"―"])
    })
    const ws=XLSX.utils.aoa_to_sheet(rows); ws["!cols"]=[8,20,8,12,14,8].map(w=>({wch:w}))
    const wb2=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb2,ws,"作成数報告")
    XLSX.writeFile(wb2,`作成数報告_${now.toISOString().slice(0,10)}.xlsx`)
  }

  const exportEventExcel = () => {
    const rows=[["#","品目","売価","原価","粗利率","計画作成数","実際の作成数","ステータス"]]
    eventProducts.forEach(p=>{
      const st=eventStatus[p.id]||{}, mgn=gpN(Number(p.price)||0,Number(p.cost)||0)
      const statusLabel=st.status==="done"?"作成済み":st.status==="shortage"?"欠品":"未確定"
      rows.push([p.num||"",p.name,p.price,p.cost,`${mgn}%`,p.qty||0,st.actualMade||"未入力",statusLabel])
    })
    const ws=XLSX.utils.aoa_to_sheet(rows); ws["!cols"]=[4,20,8,8,8,12,14,10].map(w=>({wch:w}))
    const wb2=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb2,ws,"催事作成数")
    XLSX.writeFile(wb2,`催事作成数_${now.toISOString().slice(0,10)}.xlsx`)
  }

  const exportDashboardExcel = () => {
    if(!rd) return
    const rows=[["■ 売上サマリー"],["期間",rd.period],["総売上",rd.totalSales],["総数量",rd.totalQty],["平均単価",rd.avgPrice],[""]]
    rows.push(["■ 店舗別ランキング"],["順位","店舗名","売上","シェア(%)"])
    ;(rd.storeRanking||[]).forEach((s,i)=>rows.push([i+1,s.name,s.sales,s.pct]))
    const ws=XLSX.utils.aoa_to_sheet(rows); ws["!cols"]=[10,20,14,10].map(w=>({wch:w}))
    const wb2=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb2,ws,"売上ダッシュボード")
    XLSX.writeFile(wb2,`ダッシュボード_${now.toISOString().slice(0,10)}.xlsx`)
  }

  const rd = reportData
  const hotSet = rd ? new Set((rd.prodSales||[]).map(p=>p.name.replace(/\s/g,""))) : new Set()
  const isHot  = name => [...hotSet].some(h=>name.replace(/\s/g,"").includes(h)||h.includes(name.replace(/\s/g,"")))
  const filtProducts = catFilter==="全品目" ? products : products.filter(p=>p.cat===catFilter)
  const filtStores   = area==="全エリア" ? stores : stores.filter(s=>s.area===area)
  const doneCount    = eventProducts.filter(p=>(eventStatus[p.id]||{}).status==="done").length
  const shortageCount= eventProducts.filter(p=>(eventStatus[p.id]||{}).status==="shortage").length
  const allConfirmed = eventProducts.length>0 && (doneCount+shortageCount)===eventProducts.length
  const timeStr = now.toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit",second:"2-digit"})
  const dateStr = now.toLocaleDateString("ja-JP",{year:"numeric",month:"long",day:"numeric",weekday:"short"})

  const TABS=[
    {id:"dashboard",label:"伝言板",icon:"📋"},{id:"sales",label:"売上",icon:"📊"},
    {id:"shelf",label:"棚割表",icon:"📋"},{id:"regular",label:"レギュラー",icon:"🥦"},{id:"event",label:"催事",icon:"🥬"},
    {id:"stores",label:"店舗・ピッキング",icon:"🏪"},{id:"stock",label:"センター在庫",icon:"🏭"},
    {id:"reports",label:"週次報告",icon:"📝"},{id:"admin",label:"管理者",icon:"⚙️"},
  ]
  const Btn=({children,onClick,style={},color=accent,outline=false,disabled=false})=>(
    <button onClick={onClick} disabled={disabled} style={{padding:"9px 18px",background:disabled?"#d1d5db":outline?"#fff":color,border:`2px solid ${disabled?"#d1d5db":outline?color:"transparent"}`,borderRadius:10,color:disabled?"#9ca3af":outline?color:"#fff",fontSize:14,fontWeight:700,cursor:disabled?"not-allowed":"pointer",display:"flex",alignItems:"center",gap:7,...style}}>
      {children}
    </button>
  )

  if(!dbReady) return (
    <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",height:"100vh",background:"#f0f4f0",gap:16}}>
      <div style={{fontSize:32,fontWeight:900,color:"#4a7c59",letterSpacing:4,fontFamily:"monospace"}}>OTOKAWA</div>
      <div style={{fontSize:14,color:"#6b7280"}}>接続中…</div>
      <style>{`@keyframes loading{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}`}</style>
      <div style={{width:48,height:4,borderRadius:2,background:"#dcfce7",overflow:"hidden",position:"relative"}}>
        <div style={{position:"absolute",inset:0,background:"#4a7c59",animation:"loading 1.2s ease-in-out infinite",borderRadius:2}}/>
      </div>
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
        ${festive?"@keyframes festive{0%,100%{background-position:0%}50%{background-position:100%}}.festive-banner{background:linear-gradient(90deg,#dc2626,#ef4444,#f97316,#ef4444,#dc2626);background-size:200%;animation:festive 3s ease infinite;color:#fff;text-align:center;padding:10px;font-weight:900;font-size:14px;letter-spacing:2px}":""}
      `}</style>

      {festive && <div className="festive-banner">🎉 本日はツルハの日！ 強気の送り込みで欠品防止！ 🎉</div>}

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
            {t.id==="event"&&shortageCount>0&&<span style={{fontSize:10,background:"#dc2626",color:"#fff",borderRadius:"50%",width:16,height:16,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:900}}>{shortageCount}</span>}
          </button>
        ))}
      </div>

      <div style={{padding:"20px 18px 80px",maxWidth:1400,margin:"0 auto"}} className="fade" key={tab}>

        {/* ── 伝言板 */}
        {tab==="dashboard" && (
          <div style={{display:"grid",gap:18}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
              <div>
                <h2 style={{fontSize:20,fontWeight:900}}>📋 伝言板</h2>
                <div style={{fontSize:13,color:"#6b7280",marginTop:4}}>全スタッフへの連絡・指示を記入してください</div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8,background:"#fff",border:"2px solid #dde5de",borderRadius:11,padding:"8px 14px"}}>
                <span style={{fontSize:13,fontWeight:700,color:"#6b7280"}}>📅 日付</span>
                <input type="date" value={boardDate} onChange={e=>{setBoardDate(e.target.value);dbSet("boardDate",e.target.value)}} style={{border:"none",background:"transparent",width:"auto",padding:"2px 4px",fontSize:14,fontWeight:700}}/>
              </div>
            </div>
            {[
              {key:"board_all",  label:"📢 全体への伝言", color:accent,   bg:"#f0fdf4", bd:"#86efac"},
              {key:"board_cmg",  label:"🏭 センターMG",   color:"#2563eb", bg:"#eff6ff", bd:"#93c5fd"},
              {key:"board_smg",  label:"🏬 販売部MG",     color:"#7c3aed", bg:"#f5f3ff", bd:"#c4b5fd"},
            ].map(({key,label,color,bg,bd})=>(
              <div key={key} className="card" style={{padding:20}}>
                <div style={{fontSize:15,fontWeight:900,color,marginBottom:12}}>{label}</div>
                <textarea
                  value={boardMessages[key]||""} rows={4}
                  onChange={e=>{const v=e.target.value;setBoardMessages(prev=>{const next={...prev,[key]:v};debouncedWrite("boardMessages",next);return next});setBoardUpdated(prev=>({...prev,[key]:new Date().toLocaleTimeString("ja-JP",{hour:"2-digit",minute:"2-digit"})}))}}
                  placeholder="ここに記入..."
                  style={{resize:"vertical",fontSize:15,lineHeight:1.8,background:bg,border:`2px solid ${bd}`,borderRadius:10,padding:"10px 13px",color:"#1c1c1e"}}
                />
                <div style={{fontSize:11,color:"#9ca3af",marginTop:5,textAlign:"right"}}>
                  {boardMessages[key]?`最終更新: ${boardUpdated[key]||""}`:"未記入"}
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── 売上 */}
        {tab==="sales" && (
          <div style={{display:"grid",gap:18}}>
            <h2 style={{fontSize:20,fontWeight:900}}>📊 売上レポート {rd&&<span style={{fontSize:14,fontWeight:400,color:"#6b7280"}}>{rd.period}</span>}</h2>
            <div className="card" style={{padding:20}}>
              <div style={{fontSize:14,fontWeight:800,marginBottom:10}}>📥 LINEワークス レポート貼り付け</div>
              <textarea value={pasteText} onChange={e=>{setPasteText(e.target.value);setParseError(false)}} rows={6} style={{resize:"vertical",fontSize:13,lineHeight:1.8}} placeholder="LINEワークスのレポートをここにコピペ..."/>
              {parseError&&<div style={{background:"#fee2e2",borderRadius:8,padding:"8px 12px",marginTop:9,fontSize:13,color:"#dc2626"}}>⚠️ 解析できませんでした</div>}
              <div style={{display:"flex",gap:9,justifyContent:"flex-end",marginTop:11}}>
                <Btn onClick={()=>{const p=parseReport(pasteText);if(!p||(!(p.totalSales>0)&&!(p.totalQty>0)&&!(p.storeRanking||[]).length)){setParseError(true);return};setParseError(false);setReportData(p);setPasteText("")}} style={{padding:"8px 22px",background:pasteText.length>10?accent:"#d1d5db"}}>✅ 反映する</Btn>
              </div>
            </div>
            {rd&&(
              <>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:11}}>
                  {[{l:"総売上",v:fmtJP(rd.totalSales),c:"#16a34a"},{l:"総数量",v:`${(rd.totalQty||0).toLocaleString()}点`,c:"#2563eb"},{l:"平均単価",v:`${Math.round(rd.avgPrice||0)}円`,c:"#7c3aed"},{l:"出店数",v:`${(rd.storeRanking||[]).length}店`,c:accent}].map(k=>(
                    <div key={k.l} className="card" style={{padding:16}}>
                      <div style={{fontSize:12,color:"#6b7280",marginBottom:5}}>{k.l}</div>
                      <div style={{fontSize:22,fontWeight:900,color:k.c,fontFamily:"'IBM Plex Mono',monospace"}}>{k.v}</div>
                    </div>
                  ))}
                </div>
                {(rd.storeRanking||[]).length>0&&(
                  <div className="card" style={{padding:20}}>
                    <div style={{fontSize:15,fontWeight:800,marginBottom:14}}>🏬 店舗別売上ランキング</div>
                    {rd.storeRanking.map((s,i)=>(
                      <div key={i} style={{display:"grid",gridTemplateColumns:"26px 1fr 110px 50px",alignItems:"center",gap:10,marginBottom:11}}>
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

        {/* ── 棚割表 */}
        {tab==="shelf" && (
          <div style={{display:"grid",gap:18}}>
            <div>
              <h2 style={{fontSize:20,fontWeight:900}}>棚割表 — レギュラー売り場</h2>
              <div style={{fontSize:13,color:"#6b7280",marginTop:4}}>{products.length}品目</div>
            </div>
            {/* カテゴリフィルター（半額目安付き） */}
            <div style={{display:"flex",gap:7,flexWrap:"wrap"}}>
              {["全品目",...CATS].map(c=>{
                const cs=CAT[c]; const active=catFilter===c
                const CAT_DAYS={葉物:"4〜7日",果菜:"4〜7日",きのこ:"3〜5日",根菜:"10〜14日",薬味:"―",カット:"―",土もの:"―",果物:"―"}
                const dayInfo=CAT_DAYS[c]
                return (
                  <button key={c} onClick={()=>setCatFilter(c)} style={{padding:"7px 13px",borderRadius:20,fontSize:13,fontWeight:600,border:"2px solid",borderColor:active?(cs?.bd||accent):"#dde5de",background:active?(cs?.bg||accentL):"#fff",color:active?(cs?.tx||"#166534"):"#4a5568",display:"flex",flexDirection:"column",alignItems:"center",gap:1}}>
                    <span>{c}</span>
                    {dayInfo&&dayInfo!=="―"&&<span style={{fontSize:9,fontWeight:700,opacity:.75}}>半額:{dayInfo}</span>}
                  </button>
                )
              })}
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(265px,1fr))",gap:12}}>
              {(catFilter==="全品目"?products:products.filter(p=>p.cat===catFilter)).map(p=>{
                const cs=CAT[p.cat]||{bg:"#f5f5f7",tx:"#3c3c43",bd:"#e5e5ea"}
                const mgn=gpN(p.price,p.cost), hot=rd&&isHot(p.name)
                const csVal=centerStock[p.id]||"", csNum=parseInt(csVal)
                const csZero=csVal!==""&&!isNaN(csNum)&&csNum===0, csLow=!isNaN(csNum)&&csNum>0&&csNum<10
                const dVal=displayDates[p.id]||""
                // 半額基準日: use per-product override or DISCOUNT_DAYS default
                const defaultDays=DISCOUNT_DAYS[p.name]?.days||null
                const customDays=discountDayOverrides[p.id]
                const discDays=customDays!==undefined?Number(customDays):defaultDays
                let elapsed=null
                if(dVal){elapsed=Math.floor((Date.now()-new Date(dVal).getTime())/(1000*60*60*24))}
                const needsMarkdown=discDays&&elapsed!==null&&elapsed>=discDays
                return (
                  <div key={p.id} className="card" style={{padding:15,border:`2px solid ${csZero?"#dc2626":needsMarkdown?"#fca5a5":"transparent"}`}}>
                    {/* ヘッダー */}
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                        <span style={{fontSize:12,fontWeight:700,background:cs.bg,color:cs.tx,padding:"3px 8px",borderRadius:5}}>{p.rack}</span>
                        {hot&&<span className="hot">🔥HOT</span>}
                        {csZero&&<span style={{fontSize:11,background:"#dc2626",color:"#fff",padding:"2px 6px",borderRadius:4,fontWeight:700}} className="pulse">⚠️在庫0</span>}
                        {csLow&&<span style={{fontSize:11,background:"#fef9c3",color:"#854d0e",padding:"2px 6px",borderRadius:4,fontWeight:700}}>残少</span>}
                      </div>
                      <span style={{fontSize:11,background:mgn>=35?"#dcfce7":mgn>=25?"#fef9c3":"#fee2e2",color:mgn>=35?"#16a34a":mgn>=25?"#d97706":"#dc2626",padding:"2px 7px",borderRadius:5,fontWeight:700}}>{mgn}%</span>
                    </div>
                    {/* 品名・産地 */}
                    <div style={{fontSize:15,fontWeight:800,marginBottom:2}}>{p.name}</div>
                    <div style={{fontSize:12,color:"#6b7280",marginBottom:10}}>産地: {p.origin}</div>
                    {/* 売価・計画作成数（インライン） */}
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:10}}>
                      <span style={{fontSize:20,fontWeight:900,color:"#dc2626",fontFamily:"'IBM Plex Mono',monospace"}}>{fmt(p.price)}</span>
                      <span style={{fontSize:13,color:"#6b7280"}}>計画 <strong style={{color:"#166534",fontSize:15}}>{p.makeQty}</strong> 個</span>
                    </div>
                    {/* センター在庫（小さめ） */}
                    <div style={{background:csZero?"#fee2e2":csLow?"#fef9c3":csVal?"#dcfce7":"#f4f6f4",border:`1px solid ${csZero?"#fca5a5":csLow?"#fde047":csVal?"#86efac":"#e5e7eb"}`,borderRadius:7,padding:"5px 10px",marginBottom:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontSize:11,color:"#6b7280",fontWeight:600}}>📦 センター在庫</span>
                      <span style={{fontSize:16,fontWeight:800,color:csZero?"#dc2626":csLow?"#d97706":csVal?"#166534":"#9ca3af",fontFamily:"'IBM Plex Mono',monospace"}}>{csVal||"―"}</span>
                    </div>
                    {/* 半額基準日（入力可） */}
                    <div style={{background:needsMarkdown?"#fee2e2":"#fef9c3",border:`1px solid ${needsMarkdown?"#fca5a5":"#fde047"}`,borderRadius:7,padding:"6px 10px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:8}}>
                      <span style={{fontSize:12,color:needsMarkdown?"#dc2626":"#854d0e",fontWeight:700,flexShrink:0}}>
                        {needsMarkdown?"⚠️半額検討":"🗓 半額目安"}
                        {elapsed!==null&&discDays&&<span style={{marginLeft:5}}>{elapsed}/{discDays}日</span>}
                      </span>
                      <div style={{display:"flex",alignItems:"center",gap:4}}>
                        <input type="number" min="1" max="30" placeholder={defaultDays||"日数"} value={customDays!==undefined?customDays:""} onChange={e=>setDiscountDayOverrides(prev=>({...prev,[p.id]:e.target.value===""?undefined:e.target.value}))} style={{width:52,padding:"3px 5px",fontSize:13,fontWeight:700,textAlign:"center",border:"1.5px solid #fde047",background:"#fff",borderRadius:6}}/>
                        <span style={{fontSize:11,color:"#854d0e"}}>日</span>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── レギュラー */}
        {tab==="regular" && (() => {
          const regDoneCount=products.filter(p=>(regularStatus[p.id]||{}).status==="done").length
          const regShortCount=products.filter(p=>(regularStatus[p.id]||{}).status==="shortage").length
          const regAllConfirmed=products.length>0&&(regDoneCount+regShortCount)===products.length
          const sorted=[...products].sort((a,b)=>{
            const sa=(regularStatus[a.id]||{}).status, sb=(regularStatus[b.id]||{}).status
            const rA=sa==="pending"||!sa?0:1, rB=sb==="pending"||!sb?0:1
            return rA-rB
          })
          return (
          <div style={{display:"grid",gap:18}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
              <div>
                <h2 style={{fontSize:20,fontWeight:900}}>🥦 レギュラーパッケージ管理</h2>
                <div style={{fontSize:13,color:"#6b7280",marginTop:4}}>
                  {products.length}品目 ／
                  <span style={{color:"#16a34a",fontWeight:700}}> 完了{regDoneCount}</span>
                  {regShortCount>0&&<span style={{color:"#dc2626",fontWeight:700}}> ／ 欠品{regShortCount}</span>}
                </div>
              </div>
            </div>

            {regularFinalized?(
              <div style={{background:"#dcfce7",border:"2px solid #16a34a",borderRadius:14,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
                <div>
                  <div style={{fontSize:16,fontWeight:900,color:"#166534"}}>✅ レギュラーパッケージ 完了</div>
                  <div style={{fontSize:12,color:"#166534",marginTop:4}}>確定時刻: {new Date(regularFinalized).toLocaleString("ja-JP")}</div>
                </div>
                <button onClick={resetRegular} style={{padding:"7px 16px",background:"none",border:"2px solid #dc2626",borderRadius:9,color:"#dc2626",fontSize:13,fontWeight:700,cursor:"pointer"}}>🔄 リセット</button>
              </div>
            ):(
              <div style={{background:regAllConfirmed?"#dcfce7":"#fef9c3",border:`2px solid ${regAllConfirmed?"#16a34a":"#fde047"}`,borderRadius:14,padding:"14px 18px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
                <div>
                  <div style={{fontSize:14,fontWeight:800,color:regAllConfirmed?"#166534":"#854d0e"}}>{regAllConfirmed?"✅ 全品目確認済み — 最終確認を押してください":"⚠️ 全品目確認後に最終確認ボタンを押してください"}</div>
                  <div style={{fontSize:12,color:"#6b7280",marginTop:3}}>完了: {regDoneCount} / 欠品: {regShortCount} / 未確定: {products.length-regDoneCount-regShortCount}</div>
                </div>
                <Btn onClick={()=>setRegularFinalizeConfirm(true)} disabled={!regAllConfirmed} style={{padding:"9px 22px",background:regAllConfirmed?"#16a34a":"#d1d5db",fontSize:14}}>🏁 最終確認（業務終了）</Btn>
              </div>
            )}

            <div style={{background:"#fee2e2",border:"2px solid #fca5a5",borderRadius:12,padding:"14px 18px"}}>
              <div style={{fontSize:14,fontWeight:900,color:"#dc2626",marginBottom:10}}>⚠️ パッケージ作業 注意事項</div>
              <div style={{display:"grid",gap:7}}>
                {[["💰","コンテナ内はパンパンに詰めること（物流費削減）"],["✅","作成が終わったら必ず品目ごとに「作成済み」を押すこと"],["🔢","実際の作成数を入力して確定させること"],["❌","完成できなかった品目は「欠品」ボタンを押すこと"],["🏁","全品目確認後、必ず最終確認ボタンで業務終了を報告"]].map(([ic,tx])=>(
                  <div key={tx} style={{display:"flex",gap:9,alignItems:"flex-start"}}>
                    <span style={{fontSize:16,flexShrink:0}}>{ic}</span>
                    <span style={{fontSize:13,color:"#991b1b",lineHeight:1.6,fontWeight:600}}>{tx}</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(290px,1fr))",gap:12}}>
              {sorted.map((p)=>{
                const cs=CAT[p.cat]||{bg:"#f5f5f7",tx:"#3c3c43"}
                const mgn=gpN(p.price,p.cost)
                const st=regularStatus[p.id]||{}
                const isDone=st.status==="done", isShortage=st.status==="shortage"
                const disc=DISCOUNT_DAYS[p.name]
                return (
                  <div key={p.id} className="card" style={{padding:16,border:`2px solid ${isShortage?"#dc2626":isDone?"#16a34a":"#eef0ee"}`,background:isShortage?"#fff5f5":isDone?"#f0fdf4":"#fff",opacity:regularFinalized&&!isDone&&!isShortage?.7:1}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                        <span style={{fontSize:11,fontWeight:700,background:cs.bg,color:cs.tx,padding:"3px 8px",borderRadius:5}}>{p.rack}</span>
                        {isDone&&<span style={{fontSize:11,background:"#16a34a",color:"#fff",padding:"3px 9px",borderRadius:20,fontWeight:700}}>✅ 作成済み</span>}
                        {isShortage&&<span style={{fontSize:11,background:"#dc2626",color:"#fff",padding:"3px 9px",borderRadius:20,fontWeight:700}}>❌ 欠品</span>}
                        {!isDone&&!isShortage&&<span style={{fontSize:11,background:"#f4f6f4",color:"#6b7280",padding:"3px 9px",borderRadius:20,fontWeight:700}}>未確定</span>}
                      </div>
                      <span style={{fontSize:12,fontWeight:700,padding:"3px 8px",borderRadius:5,background:mgn>=35?"#dcfce7":mgn>=25?"#fef9c3":"#fee2e2",color:mgn>=35?"#16a34a":mgn>=25?"#d97706":"#dc2626"}}>{mgn}%</span>
                    </div>
                    <div style={{fontSize:17,fontWeight:900,marginBottom:3}}>{p.name}</div>
                    <div style={{fontSize:12,color:"#6b7280",marginBottom:4}}>産地: {p.origin}</div>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:10}}>
                      <span style={{fontSize:22,fontWeight:900,color:"#dc2626",fontFamily:"'IBM Plex Mono',monospace"}}>{fmt(p.price)}</span>
                      <span style={{fontSize:13,color:"#6b7280"}}>計画 <strong style={{color:"#166534",fontSize:16}}>{p.makeQty}</strong> 個</span>
                    </div>
                    {disc&&<div style={{marginBottom:10,background:"#fef9c3",border:"1px solid #fde047",borderRadius:7,padding:"5px 10px",fontSize:12,fontWeight:700,color:"#854d0e"}}>🗓 半額目安: {disc.days}日</div>}

                    <div style={{background:"#eff6ff",border:"1.5px solid #93c5fd",borderRadius:9,padding:"10px 12px",marginBottom:11}}>
                      <div style={{fontSize:14,color:"#1e40af",fontWeight:800,marginBottom:7}}>🔢 実際の作成数</div>
                      <div style={{display:"flex",gap:8,alignItems:"center"}}>
                        <input type="number" min="0" placeholder="0" value={st.actualMade||""} onChange={e=>updateRegularStatus(p.id,"actualMade",e.target.value)} style={{flex:1,padding:"8px 10px",fontSize:26,fontWeight:900,textAlign:"center",fontFamily:"'IBM Plex Mono',monospace",border:"2px solid #93c5fd",borderRadius:8,background:"#fff"}}/>
                        <span style={{fontSize:16,color:"#6b7280",fontWeight:700}}>個</span>
                      </div>
                    </div>

                    {!regularFinalized&&(
                      <div style={{display:"flex",gap:7}}>
                        <button onClick={()=>updateRegularStatus(p.id,"status",isDone?"pending":"done")} style={{flex:1,padding:"11px",background:isDone?"#dcfce7":"#f0fdf4",border:`2px solid ${isDone?"#16a34a":"#86efac"}`,borderRadius:9,fontSize:14,fontWeight:800,color:"#166534",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
                          {isDone?"✅ 作成済み":"✅ 作成済みにする"}
                        </button>
                        <button onClick={()=>updateRegularStatus(p.id,"status",isShortage?"pending":"shortage")} style={{flex:1,padding:"11px",background:isShortage?"#fee2e2":"#fff5f5",border:`2px solid ${isShortage?"#dc2626":"#fca5a5"}`,borderRadius:9,fontSize:14,fontWeight:800,color:"#dc2626",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
                          {isShortage?"❌ 欠品中":"❌ 欠品にする"}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
          )
        })()}

        {/* ── 催事 🥬 */}
        {tab==="event" && (
          <div style={{display:"grid",gap:18}}>
            {/* ヘッダー */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
              <div>
                <h2 style={{fontSize:20,fontWeight:900}}>🥬 催事パッケージ管理</h2>
                <div style={{fontSize:13,color:"#6b7280",marginTop:4}}>
                  コンテナ: <strong>619番</strong> ／ {eventProducts.length}品目 ／
                  <span style={{color:"#16a34a",fontWeight:700}}> 完了{doneCount}</span> ／
                  {shortageCount>0&&<span style={{color:"#dc2626",fontWeight:700}}> 欠品{shortageCount}</span>}
                </div>
              </div>
              <div style={{display:"flex",gap:8}}>
                <Btn onClick={()=>setShowAddEvent(true)} style={{padding:"7px 14px",fontSize:13,background:"#d97706"}}>＋ 品目追加</Btn>
                <Btn onClick={exportEventExcel} style={{padding:"7px 14px",fontSize:13,background:"#2563eb"}}>📥 催事Excel出力</Btn>
              </div>
            </div>

            {/* 最終確認バナー */}
            {packageFinalized ? (
              <div style={{background:"#dcfce7",border:"2px solid #16a34a",borderRadius:14,padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
                <div>
                  <div style={{fontSize:16,fontWeight:900,color:"#166534"}}>✅ パッケージ業務 完了</div>
                  <div style={{fontSize:12,color:"#166534",marginTop:4}}>確定時刻: {new Date(packageFinalized).toLocaleString("ja-JP")}</div>
                </div>
                <button onClick={resetPackage} style={{padding:"7px 16px",background:"none",border:"2px solid #dc2626",borderRadius:9,color:"#dc2626",fontSize:13,fontWeight:700,cursor:"pointer"}}>🔄 リセット</button>
              </div>
            ) : (
              <div style={{background:allConfirmed?"#dcfce7":"#fef9c3",border:`2px solid ${allConfirmed?"#16a34a":"#fde047"}`,borderRadius:14,padding:"14px 18px",display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:12}}>
                <div>
                  <div style={{fontSize:14,fontWeight:800,color:allConfirmed?"#166534":"#854d0e"}}>
                    {allConfirmed?"✅ 全品目確認済み — 最終確認ボタンを押してください":"⚠️ 全品目の確認後に最終確認ボタンを押してください"}
                  </div>
                  <div style={{fontSize:12,color:"#6b7280",marginTop:3}}>完了: {doneCount} / 欠品: {shortageCount} / 未確定: {eventProducts.length-doneCount-shortageCount}</div>
                </div>
                <Btn onClick={()=>setFinalizeConfirm(true)} disabled={!allConfirmed} style={{padding:"9px 22px",background:allConfirmed?"#16a34a":"#d1d5db",fontSize:14}}>🏁 最終確認（業務終了）</Btn>
              </div>
            )}

            {/* 注意喚起 */}
            <div style={{background:"#fee2e2",border:"2px solid #fca5a5",borderRadius:12,padding:"14px 18px"}}>
              <div style={{fontSize:14,fontWeight:900,color:"#dc2626",marginBottom:10}}>⚠️ パッケージ作業 注意事項</div>
              <div style={{display:"grid",gap:7}}>
                {[
                  ["💰","物流費がかかるため、コンテナ内はパンパンに詰めること"],
                  ["✅","作成が終わったら必ず品目ごとに「作成済み」を押してチェックを入れること"],
                  ["🔢","作成数を入力し「確定」させること"],
                  ["❌","完成できなかった品目は「欠品」ボタンを押すこと"],
                  ["🏁","全品目確認後、必ず最終確認ボタンを押して業務終了を報告すること"],
                ].map(([ic,tx])=>(
                  <div key={tx} style={{display:"flex",gap:9,alignItems:"flex-start"}}>
                    <span style={{fontSize:16,flexShrink:0}}>{ic}</span>
                    <span style={{fontSize:13,color:"#991b1b",lineHeight:1.6,fontWeight:600}}>{tx}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* 品目カード */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(290px,1fr))",gap:12}}>
              {[...eventProducts].sort((a,b)=>{
                const sa=(eventStatus[a.id]||{}).status, sb=(eventStatus[b.id]||{}).status
                const rA=sa==="pending"||!sa?0:1, rB=sb==="pending"||!sb?0:1
                return rA-rB
              }).map((p,i)=>{
                const price=Number(p.price)||0, cost=Number(p.cost)||0, mgn=gpN(price,cost)
                const st=eventStatus[p.id]||{}
                const isDone=st.status==="done", isShortage=st.status==="shortage"
                return (
                  <div key={p.id||i} className="card" style={{padding:16,border:`2px solid ${isShortage?"#dc2626":isDone?"#16a34a":"#eef0ee"}`,background:isShortage?"#fff5f5":isDone?"#f0fdf4":"#fff",opacity:packageFinalized&&!isDone&&!isShortage?.7:1}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        <span style={{fontSize:13,fontWeight:900,color:"#c7c7cc"}}>#{p.num||i+1}</span>
                        {isDone&&<span style={{fontSize:11,background:"#16a34a",color:"#fff",padding:"3px 9px",borderRadius:20,fontWeight:700}}>✅ 作成済み</span>}
                        {isShortage&&<span style={{fontSize:11,background:"#dc2626",color:"#fff",padding:"3px 9px",borderRadius:20,fontWeight:700}}>❌ 欠品</span>}
                        {!isDone&&!isShortage&&<span style={{fontSize:11,background:"#f4f6f4",color:"#6b7280",padding:"3px 9px",borderRadius:20,fontWeight:700}}>未確定</span>}
                      </div>
                      <span style={{fontSize:12,fontWeight:700,padding:"3px 8px",borderRadius:5,background:mgn>=40?"#dcfce7":mgn>=25?"#fef9c3":"#fee2e2",color:mgn>=40?"#16a34a":mgn>=25?"#d97706":"#dc2626"}}>{mgn}%</span>
                    </div>
                    <div style={{fontSize:19,fontWeight:900,marginBottom:3}}>{p.name}</div>
                    {p.origin&&<div style={{fontSize:12,color:"#6b7280",marginBottom:3}}>産地: {p.origin}</div>}
                    {p.note&&<div style={{fontSize:11,color:"#d97706",marginBottom:6,fontWeight:700}}>({p.note})</div>}
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",marginBottom:12}}>
                      <span style={{fontSize:22,fontWeight:900,color:"#dc2626",fontFamily:"'IBM Plex Mono',monospace"}}>¥{price.toLocaleString()}</span>
                      <span style={{fontSize:13,color:"#6b7280"}}>計画 <strong style={{color:"#166534",fontSize:16}}>{p.qty||0}</strong> 個</span>
                    </div>
                    {/* 実作成数入力 */}
                    <div style={{background:"#eff6ff",border:"1.5px solid #93c5fd",borderRadius:9,padding:"9px 12px",marginBottom:11}}>
                      <div style={{fontSize:12,color:"#1e40af",fontWeight:700,marginBottom:6}}>🔢 実際の作成数</div>
                      <div style={{display:"flex",gap:8,alignItems:"center"}}>
                        <input type="number" min="0" placeholder="0" value={st.actualMade||""} onChange={e=>updateEventStatus(p.id,"actualMade",e.target.value)} style={{flex:1,padding:"8px 10px",fontSize:26,fontWeight:900,textAlign:"center",fontFamily:"'IBM Plex Mono',monospace",border:"2px solid #93c5fd",borderRadius:8,background:"#fff"}}/>
                        <span style={{fontSize:14,color:"#6b7280",fontWeight:600}}>個</span>
                      </div>
                    </div>
                    {/* アクションボタン */}
                    {!packageFinalized && (
                      <div style={{display:"flex",gap:7}}>
                        <button onClick={()=>updateEventStatus(p.id,"status",isDone?"pending":"done")} style={{flex:1,padding:"10px",background:isDone?"#dcfce7":"#f0fdf4",border:`2px solid ${isDone?"#16a34a":"#86efac"}`,borderRadius:9,fontSize:13,fontWeight:800,color:"#166534",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
                          {isDone?"✅ 作成済み":"✅ 作成済みにする"}
                        </button>
                        <button onClick={()=>updateEventStatus(p.id,"status",isShortage?"pending":"shortage")} style={{flex:1,padding:"10px",background:isShortage?"#fee2e2":"#fff5f5",border:`2px solid ${isShortage?"#dc2626":"#fca5a5"}`,borderRadius:9,fontSize:13,fontWeight:800,color:"#dc2626",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:5}}>
                          {isShortage?"❌ 欠品中":"❌ 欠品にする"}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* ── 店舗・ピッキング */}
        {tab==="stores" && (() => {
          // 配送スケジュール: 配送曜日 → 前日でピッキング
          const DELIVERY_DAYS = {
            "月":["白河","須賀川","郡山","矢吹"],
            "火":["会津","福島"],
            "水":["白河","須賀川","郡山","矢吹"],
            "木":["いわき","福島"],
            "金":["会津"],
            "土":["白河","須賀川","郡山","矢吹","いわき"],
            "日":["会津","福島"],
          }
          const DAY_NAMES=["日","月","火","水","木","金","土"]
          const todayIdx=new Date().getDay() // 0=日
          const tomorrowIdx=(todayIdx+1)%7
          const tomorrowDay=DAY_NAMES[tomorrowIdx]
          const autoAreas=DELIVERY_DAYS[tomorrowDay]||[]

          const activeFilter=pickingDayFilter==="auto"?tomorrowDay:pickingDayFilter
          const activeAreas=pickingDayFilter==="全体"?null:(DELIVERY_DAYS[activeFilter]||[])

          const filteredStores=[...stores]
            .filter(s=>!activeAreas||activeAreas.includes(s.area))
            .sort((a,b)=>{
              const da=pickingDone[a.id]?1:0, db2=pickingDone[b.id]?1:0
              return da-db2
            })

          const totalCases=filteredStores.reduce((sum,s)=>sum+Number((shipReport[s.id]||{}).caseCount||0),0)
          const doneCount2=filteredStores.filter(s=>pickingDone[s.id]).length
          const doneTotal=filteredStores.filter(s=>pickingDone[s.id]).reduce((sum,s)=>sum+Number((shipReport[s.id]||{}).caseCount||0),0)

          const DAY_TABS=["auto","全体","月","火","水","木","金","土","日"]

          return (
          <div style={{display:"grid",gap:16}}>
            {/* ヘッダー */}
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",flexWrap:"wrap",gap:12}}>
              <div>
                <h2 style={{fontSize:20,fontWeight:900}}>🏪 店舗ピッキング管理</h2>
                <div style={{fontSize:13,color:"#6b7280",marginTop:4}}>明日の配送: <strong style={{color:accent}}>{tomorrowDay}曜日</strong> — {autoAreas.join("・")}エリア</div>
              </div>
              <Btn onClick={exportShipExcel}>📥 出荷Excel</Btn>
            </div>

            {/* 曜日フィルタータブ */}
            <div style={{background:"#fff",borderRadius:12,padding:"10px 14px",boxShadow:"0 2px 8px rgba(0,0,0,.06)"}}>
              <div style={{fontSize:12,fontWeight:700,color:"#6b7280",marginBottom:8}}>📅 ピッキング日（配送前日で自動設定）</div>
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                {DAY_TABS.map(d=>{
                  const isActive=pickingDayFilter===d
                  const label=d==="auto"?`自動(${tomorrowDay}曜)`:d
                  const isToday=d==="auto"||d===tomorrowDay
                  return (
                    <button key={d} onClick={()=>setPickingDayFilter(d)} style={{padding:"6px 13px",borderRadius:20,fontSize:13,fontWeight:isActive?800:500,border:"2px solid",borderColor:isActive?accent:"#dde5de",background:isActive?accent:isToday&&d!=="auto"?accentL:"#fff",color:isActive?"#fff":"#4a5568"}}>
                      {label}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* サマリーバー */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10}}>
              {[
                {l:"対象店舗",v:`${filteredStores.length}店`,c:"#1c1c1e"},
                {l:"合計ケース数",v:`${totalCases}C`,c:"#2563eb"},
                {l:"作成済み",v:`${doneCount2}/${filteredStores.length}店`,c:"#16a34a"},
                {l:"済ケース数",v:`${doneTotal}C`,c:accent},
              ].map(k=>(
                <div key={k.l} className="card" style={{padding:"12px 14px"}}>
                  <div style={{fontSize:11,color:"#6b7280",marginBottom:3}}>{k.l}</div>
                  <div style={{fontSize:20,fontWeight:900,color:k.c,fontFamily:"'IBM Plex Mono',monospace"}}>{k.v}</div>
                </div>
              ))}
            </div>

            {/* 出荷日 */}
            <div style={{display:"flex",alignItems:"center",gap:9,background:"#fff",border:"2px solid #dde5de",borderRadius:11,padding:"9px 14px",width:"fit-content"}}>
              <span style={{fontSize:13,fontWeight:700,color:"#6b7280"}}>📅 出荷日</span>
              <input type="date" value={shipDate} onChange={e=>setShipDate(e.target.value)} style={{border:"none",background:"transparent",width:"auto",padding:"4px 6px",fontSize:14,fontWeight:700}}/>
            </div>

            {/* 配送スケジュール */}
            <div className="card" style={{padding:14}}>
              <div style={{fontSize:13,fontWeight:800,marginBottom:8}}>🚚 配送スケジュール（週3サイクル）</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:7}}>
                {[{area:"白河・須賀川・郡山・矢吹",days:"月・水・土",c:"#4a7c59"},{area:"会津全域",days:"火・金・日",c:"#7c3aed"},{area:"いわき",days:"月・木・土",c:"#2563eb"},{area:"福島市",days:"火・木・日",c:"#d97706"}].map(d=>(
                  <div key={d.area} style={{background:"#f9fafb",borderRadius:8,padding:"8px 12px",borderLeft:`4px solid ${d.c}`}}>
                    <div style={{fontSize:11,color:"#6b7280",marginBottom:2}}>{d.area}</div>
                    <div style={{fontSize:14,fontWeight:900,color:d.c}}>{d.days}</div>
                  </div>
                ))}
              </div>
              <div style={{marginTop:9,background:"#fef9c3",border:"1px solid #fde047",borderRadius:7,padding:"7px 11px",fontSize:12,color:"#854d0e",fontWeight:600}}>
                ⭐ ツルハの日（1・10・20日）と土曜日は強気の送り込みで欠品防止
              </div>
            </div>

            {/* コンテナ目安 */}
            <div className="card" style={{padding:14}}>
              <div style={{fontSize:13,fontWeight:800,marginBottom:8}}>📦 催事コンテナ送り込み目安</div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:7}}>
                {Object.entries(EVENT_CONTAINER_TARGET).map(([rank,num])=>{
                  const rs=RANK[rank]||{bg:"#f5f5f7",tx:"#6b7280"}
                  return (
                    <div key={rank} style={{background:rs.bg,borderRadius:9,padding:"10px",textAlign:"center"}}>
                      <div style={{fontSize:11,color:rs.tx,fontWeight:700,marginBottom:3}}>ランク{rank}</div>
                      <div style={{fontSize:18,fontWeight:900,color:rs.tx,fontFamily:"'IBM Plex Mono',monospace"}}>{typeof num==="number"?`${num}C+`:num}</div>
                    </div>
                  )
                })}
              </div>
            </div>

            {/* 店舗カード */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:11}}>
              {filteredStores.map(s=>{
                const rs=RANK[s.rank]||{bg:"#f5f5f7",tx:"#6b7280"}
                const sr=shipReport[s.id]||{caseCount:"",note:""}
                const isA=s.rank==="A"
                const target=EVENT_CONTAINER_TARGET[s.rank]
                const done=!!pickingDone[s.id]
                return (
                  <div key={s.id} className="card" style={{padding:isA?18:14,border:`2px solid ${done?"#16a34a":isA?"#d97706":"#eef0ee"}`,background:done?"#f0fdf4":isA?"linear-gradient(135deg,#fffbeb,#fff)":"#fff",position:"relative",overflow:"hidden",opacity:done?.85:1}}>
                    {isA&&!done&&<div style={{position:"absolute",top:0,right:0,width:0,height:0,borderStyle:"solid",borderWidth:"0 32px 32px 0",borderColor:"transparent #d97706 transparent transparent"}}/>}
                    {isA&&!done&&<div style={{position:"absolute",top:4,right:3,color:"#fff",fontSize:9,fontWeight:900}}>A</div>}
                    <div style={{marginBottom:9}}>
                      <div style={{display:"flex",gap:5,marginBottom:5,flexWrap:"wrap"}}>
                        <span style={{fontSize:11,fontWeight:700,background:rs.bg,color:rs.tx,padding:"2px 8px",borderRadius:4}}>Rank {s.rank}</span>
                        <span style={{fontSize:11,background:"#f0f4f0",color:"#4a5568",padding:"2px 7px",borderRadius:4}}>{s.area}</span>
                        <span style={{fontSize:11,background:s.logistics==="自社"?"#dcfce7":"#ede9fe",color:s.logistics==="自社"?"#166534":"#5b21b6",padding:"2px 7px",borderRadius:4}}>{s.logistics}</span>
                        <span style={{fontSize:11,background:"#f0fdf4",color:"#166534",padding:"2px 7px",borderRadius:4,fontWeight:700}}>{s.deliveryDays}</span>
                        {done&&<span style={{fontSize:11,background:"#16a34a",color:"#fff",padding:"2px 8px",borderRadius:4,fontWeight:700}}>✅ 作成済み</span>}
                      </div>
                      <div style={{fontSize:isA?16:14,fontWeight:900,color:done?"#166534":isA?"#92400e":"#1c1c1e"}}>{s.name}</div>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4,marginBottom:9,fontSize:11,background:"#f9fafb",borderRadius:7,padding:"8px 10px"}}>
                      <div><span style={{color:"#9ca3af"}}>🕐 </span><strong>{s.time}</strong></div>
                      <div><span style={{color:"#9ca3af"}}>📐 </span><strong>{s.shelfSize}</strong></div>
                      <div><span style={{color:"#9ca3af"}}>🎯 </span><strong>{s.eventSetup||"―"}</strong></div>
                      <div><span style={{color:"#9ca3af"}}>外売 </span><strong>{s.outsideSale||"―"}</strong></div>
                      {s.note&&<div style={{gridColumn:"1/-1",color:"#d97706",fontWeight:700}}>⚠️ {s.note}</div>}
                    </div>
                    {target&&<div style={{marginBottom:9,background:"#fef9c3",borderRadius:7,padding:"5px 9px",fontSize:12,fontWeight:700,color:"#854d0e"}}>📦 催事目安: {typeof target==="number"?`${target}コンテナ以上`:target}</div>}
                    <div style={{display:"flex",gap:7,alignItems:"flex-start",marginBottom:9}}>
                      <div style={{flex:1}}>
                        <div style={{fontSize:11,color:"#6b7280",marginBottom:2,fontWeight:600}}>備考</div>
                        <input type="text" placeholder="特記事項..." value={sr.note||""} onChange={e=>updateShipReport(s.id,"note",e.target.value)} style={{padding:"6px 9px",fontSize:12}}/>
                      </div>
                      <div>
                        <div style={{fontSize:11,color:"#6b7280",marginBottom:2,fontWeight:600}}>ケース数</div>
                        <input type="number" min="0" placeholder="0" value={sr.caseCount||""} onChange={e=>updateShipReport(s.id,"caseCount",e.target.value)} style={{padding:"6px 8px",fontSize:15,fontWeight:800,textAlign:"center",width:72,border:`2px solid ${isA?"#d97706":"#dde5de"}`}}/>
                      </div>
                    </div>
                    {/* 作成済みチェック */}
                    <button onClick={()=>setPickingDone(prev=>{const next={...prev,[s.id]:!done};dbSet("pickingDone",next);return next})} style={{width:"100%",padding:"10px",background:done?"#dcfce7":"#f4f6f4",border:`2px solid ${done?"#16a34a":"#dde5de"}`,borderRadius:9,fontSize:14,fontWeight:800,color:done?"#166534":"#6b7280",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:7}}>
                      {done?"✅ 作成済み（タップで戻す）":"☐ 作成済みにする"}
                    </button>
                    <div style={{marginTop:7,fontSize:11,background:"#ede9fe",color:"#5b21b6",padding:"3px 8px",borderRadius:4,display:"inline-block",fontWeight:700}}>📦 619番</div>
                  </div>
                )
              })}
            </div>
          </div>
          )
        })()}

        {/* ── センター在庫 */}
        {tab==="stock" && (
          <div style={{display:"grid",gap:18}}>
            <h2 style={{fontSize:20,fontWeight:900}}>🏭 センター在庫管理</h2>
            <div style={{background:"#dcfce7",border:"1px solid #86efac",borderRadius:10,padding:"10px 14px",fontSize:13,color:"#166534",fontWeight:600}}>
              ✅ 入力した数値は全スタッフのアプリにリアルタイム反映されます
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:11}}>
              {[{l:"入力済み",v:products.filter(p=>centerStock[p.id]!=null&&centerStock[p.id]!=="").length,c:"#16a34a"},{l:"在庫0",v:products.filter(p=>parseInt(centerStock[p.id])===0).length,c:"#dc2626"},{l:"残少(10未満)",v:products.filter(p=>{const n=parseInt(centerStock[p.id]);return!isNaN(n)&&n>0&&n<10}).length,c:"#d97706"}].map(k=>(
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
                          {r.isNew&&<span style={{fontSize:11,background:"#ef4444",color:"#fff",padding:"2px 7px",borderRadius:4,fontWeight:700}}>NEW</span>}
                          {r.mgRead&&<span style={{fontSize:11,background:"#dcfce7",color:"#166534",padding:"2px 7px",borderRadius:4,fontWeight:700}}>✓ MG確認済</span>}
                        </div>
                        <div style={{fontSize:12,color:"#6b7280",marginTop:2}}>{r.date}</div>
                      </div>
                    </div>
                    {!r.mgRead&&r._key&&<Btn onClick={()=>markMgRead(r._key)} style={{padding:"5px 12px",fontSize:12}}>✓ MG確認</Btn>}
                  </div>
                  <div style={{display:"grid",gap:7}}>
                    <div style={{background:"#f4f6f4",borderRadius:8,padding:"11px 13px"}}>
                      <div style={{fontSize:11,color:"#6b7280",fontWeight:600,marginBottom:4}}>📝 気になった点・所感</div>
                      <div style={{fontSize:13,lineHeight:1.8}}>{r.note||"―"}</div>
                    </div>
                    {r.storeMsg&&(
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
              🔥 Firebase接続済み — すべての変更がリアルタイムで全スタッフに反映
            </div>
            <div className="card" style={{padding:20}}>
              <div style={{fontSize:15,fontWeight:800,marginBottom:5}}>📊 棚割・催事 Excel更新</div>
              <div style={{fontSize:13,color:"#6b7280",marginBottom:13}}>ツルハドラッグ.xlsx をアップロード → 全スタッフに即時反映</div>
              <div style={{display:"flex",alignItems:"center",gap:11,flexWrap:"wrap"}}>
                <button onClick={()=>xlsxRef.current?.click()} style={{padding:"9px 20px",background:xlsxImporting?"#f0f4f0":"#2d5a3d",border:"none",borderRadius:9,color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>
                  {xlsxImporting?"⏳ 読込中...":"📊 Excelを読み込む"}
                </button>
                <input ref={xlsxRef} type="file" accept=".xlsx,.xls" style={{display:"none"}} onChange={e=>{if(e.target.files[0])handleXlsxUpload(e.target.files[0]);e.target.value=""}}/>
                {xlsxResult&&(
                  <div style={{display:"flex",alignItems:"center",gap:9,flexWrap:"wrap"}}>
                    <span style={{fontSize:13,color:"#166534",fontWeight:600}}>✅ {xlsxResult.products?.length||0}品 / 催事{xlsxResult.eventProducts?.length||0}品</span>
                    <Btn onClick={applyXlsx} style={{padding:"7px 16px"}}>✅ 反映する</Btn>
                    <Btn outline color={accent} onClick={()=>setXlsxResult(null)} style={{padding:"7px 11px"}}>閉じる</Btn>
                  </div>
                )}
              </div>
              {xlsxError&&<div style={{marginTop:9,background:"#fee2e2",borderRadius:7,padding:"7px 11px",fontSize:13,color:"#dc2626"}}>⚠️ {xlsxError}</div>}
            </div>
            <div className="card" style={{padding:20}}>
              <div style={{fontSize:15,fontWeight:800,marginBottom:5}}>🏪 店舗情報 一括登録</div>
              <div style={{display:"flex",alignItems:"center",gap:11,flexWrap:"wrap"}}>
                <button onClick={()=>storeRef.current?.click()} style={{padding:"9px 20px",background:storeImporting?"#f0f4f0":"#1e40af",border:"none",borderRadius:9,color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>
                  {storeImporting?"⏳ 読込中...":"🏪 店舗Excelを読み込む"}
                </button>
                <input ref={storeRef} type="file" accept=".xlsx,.xls" style={{display:"none"}} onChange={e=>{if(e.target.files[0])handleStoreImport(e.target.files[0]);e.target.value=""}}/>
                {storeImportResult&&(
                  <div style={{display:"flex",alignItems:"center",gap:9,flexWrap:"wrap"}}>
                    <span style={{fontSize:13,color:"#166534",fontWeight:600}}>✅ {storeImportResult.length}店舗</span>
                    <Btn onClick={applyStoreImport} style={{padding:"7px 16px"}}>✅ 反映する</Btn>
                    <Btn outline color={accent} onClick={()=>setStoreImportResult(null)} style={{padding:"7px 11px"}}>閉じる</Btn>
                  </div>
                )}
              </div>
              {storeImportError&&<div style={{marginTop:9,background:"#fee2e2",borderRadius:7,padding:"7px 11px",fontSize:13,color:"#dc2626"}}>⚠️ {storeImportError}</div>}
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
                {[{l:"稼働中店舗",v:`${stores.length}店舗`},{l:"レギュラー品目",v:`${products.length}品`},{l:"催事品目",v:`${eventProducts.length}品`},{l:"週次報告",v:`${weeklyReports.length}件`},{l:"MG未確認",v:`${weeklyReports.filter(r=>!r.mgRead).length}件`,red:weeklyReports.some(r=>!r.mgRead)},{l:"DB同期",v:"LIVE 🟢",green:true},{l:"パッケージ",v:packageFinalized?"完了✅":"作業中",green:!!packageFinalized}].map(k=>(
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

      {/* レギュラー最終確認モーダル */}
      {regularFinalizeConfirm && (
        <div className="ov" onClick={()=>setRegularFinalizeConfirm(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:420,textAlign:"center"}}>
            <div style={{fontSize:48,marginBottom:16}}>🏁</div>
            <div style={{fontSize:20,fontWeight:900,marginBottom:10}}>レギュラーパッケージ業務を終了しますか？</div>
            <div style={{fontSize:14,color:"#6b7280",marginBottom:8}}>
              完了: {products.filter(p=>(regularStatus[p.id]||{}).status==="done").length}品 ／
              欠品: {products.filter(p=>(regularStatus[p.id]||{}).status==="shortage").length}品
            </div>
            <div style={{fontSize:13,color:"#6b7280",marginBottom:24}}>確定後は全スタッフに通知されます</div>
            <div style={{display:"flex",gap:11,justifyContent:"center"}}>
              <Btn outline color={accent} onClick={()=>setRegularFinalizeConfirm(false)} style={{padding:"10px 22px"}}>キャンセル</Btn>
              <Btn onClick={finalizeRegular} style={{padding:"10px 28px",background:"#16a34a",fontSize:15}}>✅ 業務終了を確定</Btn>
            </div>
          </div>
        </div>
      )}

      {/* 催事品目追加モーダル */}
      {showAddEvent && (
        <div className="ov" onClick={()=>setShowAddEvent(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:16}}>
              <div style={{fontSize:17,fontWeight:900}}>＋ 催事品目を追加</div>
              <button onClick={()=>setShowAddEvent(false)} style={{background:"none",border:"none",fontSize:22,color:"#8e9e91",cursor:"pointer"}}>✕</button>
            </div>
            <div style={{display:"grid",gap:11}}>
              {[["品目名 *","name","text","例: 長芋1本"],["売価 *","price","number","例: 199"],["原価","cost","number","例: 120"],["計画作成数","qty","number","例: 200"],["産地","origin","text","例: 福島"],["備考","note","text","例: 社長指示"]].map(([l,f,t,ph])=>(
                <div key={f}>
                  <div style={{fontSize:13,fontWeight:700,marginBottom:5}}>{l}</div>
                  <input type={t} placeholder={ph} value={newEventItem[f]} onChange={e=>setNewEventItem(p=>({...p,[f]:e.target.value}))} style={{fontSize:15}}/>
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:9,justifyContent:"flex-end",marginTop:18}}>
              <Btn outline color={accent} onClick={()=>setShowAddEvent(false)} style={{padding:"8px 16px"}}>キャンセル</Btn>
              <Btn onClick={addEventProduct} style={{padding:"8px 22px",background:newEventItem.name&&newEventItem.price?accent:"#d1d5db"}}>＋ 追加する</Btn>
            </div>
          </div>
        </div>
      )}

      {/* 最終確認モーダル */}
      {finalizeConfirm && (
        <div className="ov" onClick={()=>setFinalizeConfirm(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()} style={{maxWidth:420,textAlign:"center"}}>
            <div style={{fontSize:48,marginBottom:16}}>🏁</div>
            <div style={{fontSize:20,fontWeight:900,marginBottom:10}}>パッケージ業務を終了しますか？</div>
            <div style={{fontSize:14,color:"#6b7280",marginBottom:8}}>完了: {doneCount}品 ／ 欠品: {shortageCount}品</div>
            <div style={{fontSize:13,color:"#6b7280",marginBottom:24}}>確定後は全スタッフに通知されます</div>
            <div style={{display:"flex",gap:11,justifyContent:"center"}}>
              <Btn outline color={accent} onClick={()=>setFinalizeConfirm(false)} style={{padding:"10px 22px"}}>キャンセル</Btn>
              <Btn onClick={finalizePackage} style={{padding:"10px 28px",background:"#16a34a",fontSize:15}}>✅ 業務終了を確定</Btn>
            </div>
          </div>
        </div>
      )}

      {/* レポート入力モーダル */}
      {inputOpen && (
        <div className="ov" onClick={()=>setInputOpen(false)}>
          <div className="modal" onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:15}}>
              <div style={{fontSize:17,fontWeight:900}}>📥 売上レポート入力</div>
              <button onClick={()=>setInputOpen(false)} style={{background:"none",border:"none",fontSize:22,color:"#8e9e91",cursor:"pointer"}}>✕</button>
            </div>
            <textarea value={pasteText} onChange={e=>{setPasteText(e.target.value);setParseError(false)}} rows={10} style={{resize:"vertical",fontSize:13,lineHeight:1.8}} placeholder="LINEワークスのレポートをペースト..."/>
            {parseError&&<div style={{background:"#fee2e2",borderRadius:8,padding:"8px 12px",marginTop:9,fontSize:13,color:"#dc2626"}}>⚠️ 解析できませんでした</div>}
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
