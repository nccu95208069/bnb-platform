"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowRight, ArrowUpRight, Check, Plus } from "lucide-react";

export function DoorMark({ className = "" }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 32 38"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M3 35V15a13 13 0 0 1 26 0v20M10 35V16a6 6 0 0 1 12 0v19M1 35h30"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M16 3v7M4 11l7 3M28 11l-7 3"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  );
}

const scenarios = {
  villa: {
    label: "包棟",
    title: "一筆訂房管理多間房",
    description:
      "包棟的房間與住宿日期歸在同一筆訂房，房費與實收金額只需記錄一次。",
    rooms: ["山景房", "庭院房", "和室"],
    nights: "2 晚 · 3 間房",
    booking: "整棟入住",
    price: "18,000",
    received: "6,000",
  },
  rooms: {
    label: "單房",
    title: "按房間查看入住安排",
    description: "依房號查看入住、退房與可預訂日期，並查閱各筆訂房的收款狀態。",
    rooms: ["山景房", "庭院房", "和室"],
    nights: "2 晚 · 1 間房",
    booking: "山景房入住",
    price: "6,000",
    received: "2,000",
  },
  mixed: {
    label: "混合經營",
    title: "包棟與單房共用房況",
    description: "包棟與單房訂單使用同一組房間資料，方便核對各日期的入住安排。",
    rooms: ["山景房", "庭院房", "和室"],
    nights: "2 晚 · 3 間房",
    booking: "週末包棟",
    price: "18,000",
    received: "6,000",
  },
} as const;

export function StayDemo() {
  const [mode, setMode] = useState<keyof typeof scenarios>("villa");
  const [selected, setSelected] = useState<number | "group">("group");
  const data = scenarios[mode];
  const single = typeof selected === "number";
  const order = single
    ? {
        booking: `${data.rooms[selected]}入住`,
        nights: "2 晚 · 1 間房",
        price: ["6,000", "5,600", "4,200"][selected],
        received: ["2,000", "0", "1,400"][selected],
      }
    : data;
  return (
    <section
      className="service-experience"
      id="experience"
      aria-labelledby="experience-title"
    >
      <div className="service-section-top">
        <span className="service-eyebrow">01 / 功能介紹</span>
        <span className="service-small-note">
          房況、訂房金額與實收金額集中查看
        </span>
      </div>
      <div className="service-experience-intro" data-reveal>
        <h2 id="experience-title">
          房況與收款，
          <br />
          按訂房核對。
        </h2>
        <p>
          查看每筆訂房的房間與住宿日期，
          <br />
          分別記錄訂房總額與實際收款。
          <br />
          <span>以下可切換經營模式，查看操作示意。</span>
        </p>
      </div>
      <div className="service-demo-layout" data-reveal>
        <div className="service-demo-story">
          <div className="service-mode-label">選擇經營模式</div>
          <div
            className="service-mode-switch"
            role="group"
            aria-label="切換房況示意的經營方式"
          >
            {(Object.keys(scenarios) as (keyof typeof scenarios)[]).map(
              (key) => (
                <button
                  key={key}
                  aria-pressed={mode === key}
                  onClick={() => {
                    setMode(key);
                    setSelected(key === "rooms" ? 0 : "group");
                  }}
                >
                  {scenarios[key].label}
                </button>
              ),
            )}
          </div>
          <div className="service-demo-copy" key={mode}>
            <h3>{data.title}</h3>
            <p>{data.description}</p>
          </div>
          <p className="service-demo-hint">
            <span aria-hidden="true">↗</span>{" "}
            點選訂房，查看房間、住宿晚數與收款金額。
          </p>
        </div>
        <div className="service-calendar">
          <div className="service-calendar-heading">
            <span>
              <DoorMark /> 山邊小屋 <small>示範旅宿</small>
            </span>
            <span className="service-demo-badge">互動示意</span>
          </div>
          <div className="service-calendar-month">
            <div>
              <span className="service-serif">October</span>
              <span>10 月</span>
            </div>
            <span>2026</span>
          </div>
          <div
            role="group"
            className="service-calendar-grid"
            aria-label="10 月 16 日至 19 日房況示意"
          >
            <div className="service-calendar-dates">
              <span>房間</span>
              {["16 五", "17 六", "18 日", "19 一"].map((day) => (
                <span key={day}>{day}</span>
              ))}
            </div>
            {data.rooms.map((room, index) => (
              <div className="service-calendar-row" key={room}>
                <span>{room}</span>
                {mode === "rooms" ? (
                  <>
                    <button
                      className={`service-booking service-booking-${index}`}
                      style={{
                        gridColumn:
                          index === 1
                            ? "3 / 5"
                            : index === 2
                              ? "4 / 6"
                              : "2 / 4",
                      }}
                      onClick={() => setSelected(index)}
                      aria-pressed={selected === index}
                      aria-label={`查看${room}示範訂房`}
                    >
                      <span>{room} · 2 晚</span>
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      className="service-booking"
                      style={{ gridColumn: "2 / 4" }}
                      onClick={() => setSelected("group")}
                      aria-pressed={selected === "group"}
                      aria-label={`查看${room}的包棟示範訂房`}
                    >
                      <span>{index === 0 ? data.booking : "同筆訂房"}</span>
                      {index === 0 && <ArrowUpRight size={14} aria-hidden />}
                    </button>
                    {mode === "mixed" && index === 0 ? (
                      <button
                        className="service-booking service-booking-1"
                        style={{ gridColumn: "4 / 6" }}
                        onClick={() => setSelected(0)}
                        aria-pressed={selected === 0}
                        aria-label="查看包棟之後的山景房示範訂房"
                      >
                        單房 · 2 晚
                      </button>
                    ) : (
                      <span className="service-vacancy">可預訂</span>
                    )}
                  </>
                )}
              </div>
            ))}
          </div>
          <div className="service-order-detail" aria-live="polite">
            {
              <>
                <div className="service-order-label">
                  <span>
                    <i />
                    {order.booking}
                  </span>
                  <small>{order.nights}</small>
                </div>
                <div className="service-order-money">
                  <div>
                    <span>
                      訂房總額 <small>TWD</small>
                    </span>
                    <strong>{order.price}</strong>
                  </div>
                  <div>
                    <span>
                      旅宿已收 <small>TWD</small>
                    </span>
                    <strong>{order.received}</strong>
                  </div>
                  <div className="service-order-status">
                    <Check size={15} aria-hidden />
                    <span>
                      同筆訂房
                      <br />
                      收款分開核對
                    </span>
                  </div>
                </div>
              </>
            }
          </div>
          <p className="service-calendar-disclaimer">
            此為虛構資料示意，不會建立或修改實際訂房。
          </p>
        </div>
      </div>
    </section>
  );
}

const faqs = [
  [
    "現有訂房資料需要先整理嗎？",
    "不必先重新整理。使用 Google Sheet 可提供連結，由專人核對房間與訂房格式。使用 Excel、紙本或其他系統，請先諮詢資料整理與導入方式。",
  ],
  [
    "提供 Google Sheet 連結後，如何處理資料？",
    "請以「檢視者」權限分享試算表。專人會先核對存取權限、房間與訂房格式，再確認匯入範圍。現階段採一次性匯入，不修改原表，也不會持續同步。",
  ],
  [
    "支援哪些經營模式？",
    "支援包棟、單房與混合經營。整棟出租可先以「整棟」登記；單房出租可沿用現有房號。若有多棟或部分包棟需求，請由專人協助確認設定。",
  ],
  [
    "如何收費與開通？",
    "請透過專人諮詢確認服務內容、費用與開通安排。送出申請不會產生扣款；確認需求與資料後，再協助開通。",
  ],
] as const;

export function ServiceLanding({
  onStart,
  onConsult,
  contactEmail,
  children,
}: {
  onStart: () => void;
  onConsult: () => void;
  contactEmail: string;
  children: ReactNode;
}) {
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (
      typeof IntersectionObserver === "undefined" ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries)
          if (entry.isIntersecting) {
            entry.target.classList.add("is-visible");
            observer.unobserve(entry.target);
          }
      },
      { threshold: 0.08 },
    );
    const elements = surface.current?.querySelectorAll("[data-reveal]");
    elements?.forEach((element) => {
      element.classList.add("will-reveal");
      observer.observe(element);
    });
    return () => {
      observer.disconnect();
      elements?.forEach((element) => element.classList.remove("will-reveal"));
    };
  }, []);
  return (
    <div ref={surface}>
      <a className="service-skip" href="#service-content">
        跳到主要內容
      </a>
      <header className="service-header">
        <a className="service-brand" href="/join" aria-label="民宿 OS 首頁">
          <DoorMark />
          <span>
            民宿 <span className="service-brand-os">OS</span>
          </span>
        </a>
        <nav aria-label="服務導覽">
          <a href="#experience">功能介紹</a>
          <a href="#how-it-works">導入流程</a>
          <a href="#questions">常見問題</a>
        </nav>
        <div className="service-header-actions">
          <a className="service-login" href="/start">
            登入
          </a>
          <button className="service-header-consult" onClick={onConsult}>
            專人諮詢 <ArrowUpRight size={15} aria-hidden />
          </button>
        </div>
      </header>
      <noscript>
        <p className="service-no-script">
          互動問卷需要 JavaScript。你也可以直接{" "}
          <a href={`mailto:${contactEmail}`}>Email 聯絡專人</a>
          ，諮詢功能與導入方式。
        </p>
      </noscript>
      <section
        className="service-hero"
        id="service-content"
        aria-labelledby="service-title"
      >
        <div className="service-hero-copy">
          <p className="service-eyebrow">
            <span className="service-tiny-sun" aria-hidden />{" "}
            民宿房況與訂房管理系統
          </p>
          <h1 id="service-title">
            民宿訂房，
            <br />
            <span>集中管理。</span>
          </h1>
          <p className="service-hero-description">
            適用包棟、單房與混合經營的民宿。
            <br />
            在同一份房況日曆查看住宿安排，
            <br />
            核對訂房金額與實際收款。
          </p>
          <button
            className="service-button service-button-primary service-hero-cta"
            onClick={onStart}
          >
            申請使用 <ArrowUpRight size={18} aria-hidden />
          </button>
          <p className="service-hero-footnote">
            採申請制開通 · 可先諮詢導入方式
          </p>
        </div>
        <figure className="service-hero-visual">
          <div className="service-photo-wrap">
            {/* Locally optimized responsive image with fixed geometry; no remote image dependency. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              className="service-hero-photo"
              src="/images/service/courtyard.webp"
              srcSet="/images/service/courtyard-800.webp 800w, /images/service/courtyard.webp 1600w"
              sizes="(max-width: 700px) 100vw, 55vw"
              width="1600"
              height="1067"
              fetchPriority="high"
              alt="山景旅宿的庭院、木門與茶桌"
            />
            <div className="service-photo-shade" />
            <div className="service-photo-caption">
              <span>
                民宿 OS
                <br />
                房況與訂房管理系統
              </span>
              <DoorMark />
            </div>
          </div>
          <div className="service-stay-note">
            <span className="service-note-dot" />
            <div>
              <strong>一筆訂房，多間房間</strong>
              <span>住宿日期與收款集中核對</span>
            </div>
            <span className="service-note-line" />
          </div>
          <figcaption>
            <span>民宿 OS</span>
            <span>旅宿情境示意 · AI 原創影像</span>
          </figcaption>
        </figure>
        <a href="#experience" className="service-scroll-link">
          <ArrowDown size={16} aria-hidden />
          <span>查看功能與操作示意</span>
        </a>
      </section>
      {children}
      <div className="service-manifesto" data-reveal>
        <h2 className="service-overview-title">為小型民宿設計的管理系統</h2>
        <div>
          <span className="service-eyebrow">適用對象</span>
          <p>
            整棟出租、單房出租，或兩種模式並行。
            <br />
            沿用現有房號建立房況日曆，
            <br className="service-mobile-break" />
            管理住宿安排與訂房收款。
          </p>
        </div>
      </div>
      <StayDemo />
      <section
        className="service-begin"
        id="how-it-works"
        aria-labelledby="begin-title"
      >
        <div className="service-begin-heading" data-reveal>
          <span className="service-eyebrow">02 / 導入流程</span>
          <h2 id="begin-title">
            提供旅宿資料，
            <br />
            由專人協助
            <br />
            <em>完成導入。</em>
          </h2>
          <p>
            先確認經營模式與現有資料，
            <br />
            再安排房間設定與訂房匯入。
          </p>
          <button className="service-text-button" onClick={onStart}>
            填寫旅宿資料 <ArrowUpRight size={19} aria-hidden />
          </button>
        </div>
        <ol className="service-steps">
          {[
            [
              "01",
              "填寫旅宿與房間資料",
              "選擇包棟、單房或混合經營，填寫旅宿名稱與房號，作為後續設定的依據。",
              "PROPERTY SETUP",
            ],
            [
              "02",
              "確認現有資料來源",
              "使用 Google Sheet，請提供連結並分享檢視權限。其他格式則由專人確認整理與匯入方式。",
              "DATA REVIEW",
            ],
            [
              "03",
              "核對資料並安排開通",
              "專人會與你確認服務內容、資料格式及開通安排，再協助完成設定。",
              "ONBOARDING",
            ],
          ].map(([number, title, copy, english]) => (
            <li key={number} data-reveal>
              <span className="service-step-number">{number}</span>
              <div>
                <small>{english}</small>
                <h3>{title}</h3>
                <p>{copy}</p>
              </div>
              <ArrowDown size={20} aria-hidden />
            </li>
          ))}
        </ol>
      </section>
      <section
        className="service-faq"
        id="questions"
        aria-labelledby="faq-title"
      >
        <div data-reveal>
          <span className="service-eyebrow">03 / 常見問題</span>
          <h2 id="faq-title">使用前須知</h2>
          <button className="service-text-button" onClick={onConsult}>
            聯絡服務人員 <ArrowUpRight size={19} aria-hidden />
          </button>
        </div>
        <div className="service-faq-list">
          {faqs.map(([question, answer], index) => (
            <details key={question}>
              <summary>
                <span>
                  <small>0{index + 1}</small>
                  {question}
                </span>
                <Plus size={19} aria-hidden />
              </summary>
              <p>{answer}</p>
            </details>
          ))}
        </div>
      </section>
      <section
        className="service-invitation"
        aria-labelledby="invitation-title"
      >
        <div className="service-invitation-door" aria-hidden>
          <div />
          <div />
          <div />
          <span />
        </div>
        <div data-reveal>
          <span className="service-eyebrow">申請與諮詢</span>
          <h2 id="invitation-title">申請使用民宿 OS</h2>
          <div className="service-invitation-actions">
            <button
              className="service-button service-button-light"
              onClick={onStart}
            >
              申請使用 <ArrowUpRight size={18} aria-hidden />
            </button>
            <button className="service-invitation-consult" onClick={onConsult}>
              專人諮詢 <ArrowRight size={18} aria-hidden />
            </button>
          </div>
        </div>
        <p>送出資料後，由專人確認需求與開通安排。</p>
      </section>
      <footer className="service-footer">
        <div className="service-footer-top">
          <a className="service-brand" href="/join">
            <DoorMark />
            <span>
              民宿 <span className="service-brand-os">OS</span>
            </span>
          </a>
          <p>房況與訂房管理系統</p>
          <a className="service-footer-email" href={`mailto:${contactEmail}`}>
            {contactEmail}
            <ArrowUpRight size={16} aria-hidden />
          </a>
        </div>
        <div className="service-footer-bottom">
          <span>© 2026 民宿 OS</span>
          <span>房況 · 訂房 · 收款</span>
          <a href="#service-content">回到頂端 ↑</a>
        </div>
      </footer>
    </div>
  );
}
