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
    title: "一組客人，一起看清。",
    description:
      "一次包下的房間與夜晚，放在同一筆訂房。整棟住宿與收款，不必逐間重複記。",
    rooms: ["山景房", "庭院房", "和室"],
    nights: "2 晚 · 3 間房",
    booking: "整棟入住",
    price: "18,000",
    received: "6,000",
  },
  rooms: {
    label: "單房",
    title: "每間房，都有自己的節奏。",
    description:
      "哪間入住、哪天退房、哪些日期還空著。沿用熟悉的房名，在一份日曆裡輕鬆核對。",
    rooms: ["山景房", "庭院房", "和室"],
    nights: "2 晚 · 1 間房",
    booking: "山景房入住",
    price: "6,000",
    received: "2,000",
  },
  mixed: {
    label: "混合經營",
    title: "包棟與單房，都安頓好。",
    description:
      "平日接單房，週末開放包棟。從實際房間安排入住，讓不同的接待方式回到同一張日曆。",
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
        <span className="service-eyebrow">01 / A LITTLE MORE CLARITY</span>
        <span className="service-small-note">少一點來回翻找，多一點從容。</span>
      </div>
      <div className="service-experience-intro" data-reveal>
        <h2 id="experience-title">
          再多細節，
          <br />
          也能一眼看清。
        </h2>
        <p>
          把訂房、住宿日期與收款，
          <br />
          放進一份清楚的日曆。
          <br />
          <span>你的接待方式，值得被好好理解。</span>
        </p>
      </div>
      <div className="service-demo-layout" data-reveal>
        <div className="service-demo-story">
          <div className="service-mode-label">你的旅宿，怎麼接待？</div>
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
            <span aria-hidden="true">↗</span> 點選日曆中的訂房，看看住宿與收款。
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
    "還沒整理好資料，也可以加入嗎？",
    "可以。不論你用 Google Sheet、Excel、紙本或手機記事本，都可以先回答幾個問題。不是 Google Sheet 的話，我們會透過專人諮詢，和你確認合適的開始方式。",
  ],
  [
    "分享 Google Sheet 後，會直接修改我的資料嗎？",
    "不會。先以「檢視者」分享給我們，核對房間與訂房格式，再協助後續開通與匯入。原表不會被修改，目前也不會持續同步。",
  ],
  [
    "只有幾間房，或只有一棟，也適合嗎？",
    "這個流程就是從小型旅宿的實際房間開始。整棟出租可先填「整棟」，單房或混合經營則填熟悉的房號。若有多棟或部分包棟，專人會再協助確認。",
  ],
  [
    "費用與開通方式，什麼時候確認？",
    "送出需求後，我們會先了解你的旅宿規模、資料與需要的協助，再和你確認服務內容、費用及開通安排。填寫這份問卷不會產生扣款。",
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
          <a href="#experience">服務體驗</a>
          <a href="#how-it-works">如何開始</a>
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
          ，一起確認適合的開始方式。
        </p>
      </noscript>
      <section
        className="service-hero"
        id="service-content"
        aria-labelledby="service-title"
      >
        <div className="service-hero-copy">
          <p className="service-eyebrow">
            <span className="service-tiny-sun" aria-hidden /> MADE FOR THE WAY
            YOU HOST
          </p>
          <h1 id="service-title">
            把時間，
            <br />
            留給<span>款待。</span>
          </h1>
          <p className="service-hero-description">
            房況、訂房、收款，安頓在一起。
            <br />
            給用心經營每一間房的你，
            <br />
            一個更從容的日常。
          </p>
          <button
            className="service-button service-button-primary service-hero-cta"
            onClick={onStart}
          >
            我想加入使用 <ArrowUpRight size={18} aria-hidden />
          </button>
          <p className="service-hero-footnote">
            從你的旅宿開始 · 有專人陪你一起整理
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
              alt="午後陽光灑進安靜的旅宿庭院，木門旁是一張等待客人的茶桌"
            />
            <div className="service-photo-shade" />
            <div className="service-photo-caption">
              <span>
                把日常照顧好，
                <br />
                美好的停留，就有了空間。
              </span>
              <DoorMark />
            </div>
          </div>
          <div className="service-stay-note">
            <span className="service-note-dot" />
            <div>
              <strong>每一次入住，都好好安頓。</strong>
              <span>房況清楚，心裡也有餘裕。</span>
            </div>
            <span className="service-note-line" />
          </div>
          <figcaption>
            <span>A QUIETER WAY TO HOST.</span>
            <span>旅宿情境示意 · AI 原創影像</span>
          </figcaption>
        </figure>
        <a href="#experience" className="service-scroll-link">
          <ArrowDown size={16} aria-hidden />
          <span>往下，看看更從容的日常</span>
        </a>
      </section>
      {children}
      <div className="service-manifesto" data-reveal>
        <p className="service-english-phrase">
          Room for <em>hospitality.</em>
        </p>
        <div>
          <span className="service-eyebrow">為小而用心的旅宿而做</span>
          <p>
            你記得客人喜歡的早餐、窗邊最好的光。
            <br />
            那些散落在表格裡的大小事，
            <br className="service-mobile-break" />
            讓我們一起收好。
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
          <span className="service-eyebrow">02 / START WHERE YOU ARE</span>
          <h2 id="begin-title">
            不用全部重來。
            <br />
            從你熟悉的方式，
            <br />
            <em>開始就好。</em>
          </h2>
          <p>
            不必先研究一套新系統，
            <br />
            也不用自己摸索搬資料。
          </p>
          <button className="service-text-button" onClick={onStart}>
            開始回答問題 <ArrowUpRight size={19} aria-hidden />
          </button>
        </div>
        <ol className="service-steps">
          {[
            [
              "01",
              "先認識你的旅宿",
              "包棟、單房，或兩種都經營。告訴我們你的接待方式，沿用你熟悉的房號與名稱。",
              "YOUR PLACE",
            ],
            [
              "02",
              "接住你現有的記錄",
              "用 Google Sheet？貼上連結並分享檢視權限。紙本、Excel 或其他方式，也有專人協助。",
              "YOUR WAY",
            ],
            [
              "03",
              "一起確認，再開始",
              "核對資料與需求後，再協助開通。每一步都有清楚的下一步，不確定時，隨時找我們聊聊。",
              "YOUR PACE",
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
          <span className="service-eyebrow">03 / A FEW THINGS TO KNOW</span>
          <h2 id="faq-title">
            你可能
            <br />
            也想知道。
          </h2>
          <button className="service-text-button" onClick={onConsult}>
            直接找專人聊聊 <ArrowUpRight size={19} aria-hidden />
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
          <span className="service-eyebrow">
            GOOD DAYS BEGIN WITH A LITTLE CLARITY.
          </span>
          <h2 id="invitation-title">
            讓經營，有條理。
            <br />
            讓款待，有餘裕。
          </h2>
          <div className="service-invitation-actions">
            <button
              className="service-button service-button-light"
              onClick={onStart}
            >
              從我的旅宿開始 <ArrowUpRight size={18} aria-hidden />
            </button>
            <button className="service-invitation-consult" onClick={onConsult}>
              我想先諮詢 <ArrowRight size={18} aria-hidden />
            </button>
          </div>
        </div>
        <p>包棟 · 單房 · 每一間用心經營的旅宿</p>
      </section>
      <footer className="service-footer">
        <div className="service-footer-top">
          <a className="service-brand" href="/join">
            <DoorMark />
            <span>
              民宿 <span className="service-brand-os">OS</span>
            </span>
          </a>
          <p>把時間，留給款待。</p>
          <a className="service-footer-email" href={`mailto:${contactEmail}`}>
            {contactEmail}
            <ArrowUpRight size={16} aria-hidden />
          </a>
        </div>
        <div className="service-footer-bottom">
          <span>© 2026 民宿 OS</span>
          <span>Thoughtfully made for thoughtful hosts.</span>
          <a href="#service-content">回到頂端 ↑</a>
        </div>
      </footer>
    </div>
  );
}
