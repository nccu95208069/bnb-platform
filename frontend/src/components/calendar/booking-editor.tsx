"use client";

import { useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Baby,
  Banknote,
  BedSingle,
  CalendarClock,
  CircleDollarSign,
  CreditCard,
  History,
  Landmark,
  PawPrint,
  ReceiptText,
  Trash2,
  UserPlus,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import type { WorkspacePermissions } from "@/lib/access-control";
import {
  BABY_SUPPLY_LABELS,
  serviceRequirementLabels,
} from "@/lib/stay-utils";
import { cn } from "@/lib/utils";

import type {
  BabySupply,
  CalendarBooking,
  CalendarRoom,
  PaymentMethod,
  PaymentType,
} from "./calendar-types";

export type RecordPaymentInput = {
  amount: number;
  paymentType: PaymentType;
  paymentMethod: PaymentMethod;
  receivedAt: string;
};

export type UpdateBookingInput = {
  guestName: string;
  roomId: string;
  roomNumber: string;
  checkIn: string;
  checkOut: string;
  roomRate: number;
  extraGuestCount: number;
  extraBedCount: number;
  petCount: number;
  babySupplies: BabySupply[];
  serviceNote: string;
};

const PLATFORM_LABELS: Record<string, string> = {
  direct: "LINE／直訂",
  agoda: "Agoda",
  booking: "Booking",
  airbnb: "Airbnb",
  ctrip: "CTrip",
  owljourney: "OwlJourney",
  other: "其他",
};

const PAYMENT_LABELS = {
  paid: "已付清",
  deposit: "已付訂金",
  unpaid: "未付款",
} as const;

const PAYMENT_METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: "現金",
  bank_transfer: "匯款",
  credit_card: "信用卡",
};

const PAYMENT_TYPE_LABELS: Record<PaymentType, string> = {
  deposit: "訂金",
  balance: "尾款",
  other: "其他款項",
};

const PLATFORM_STYLES: Record<string, string> = {
  direct: "border-emerald-200 bg-emerald-50 text-emerald-950",
  agoda: "border-violet-200 bg-violet-50 text-violet-950",
  booking: "border-sky-200 bg-sky-50 text-sky-950",
  airbnb: "border-rose-200 bg-rose-50 text-rose-950",
  ctrip: "border-amber-200 bg-amber-50 text-amber-950",
  owljourney: "border-indigo-200 bg-indigo-50 text-indigo-950",
  other: "border-slate-200 bg-slate-50 text-slate-950",
};

const BABY_SUPPLIES = Object.keys(BABY_SUPPLY_LABELS) as BabySupply[];

function formatMoney(value: number, canViewPrices = true) {
  if (!canViewPrices) return "已隱藏";
  return new Intl.NumberFormat("zh-TW", {
    style: "currency",
    currency: "TWD",
    maximumFractionDigits: 0,
  }).format(value);
}

function formatDate(value: string | null) {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-TW", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T00:00:00.000Z`));
}

function dayDifference(end: string, start: string) {
  return Math.max(
    0,
    Math.round(
      (new Date(`${end}T00:00:00.000Z`).getTime() -
        new Date(`${start}T00:00:00.000Z`).getTime()) /
        86_400_000,
    ),
  );
}

function sameSourceSegment(left: CalendarBooking, right: CalendarBooking) {
  const leftIds = new Set(left.source_segment_ids ?? [left.id]);
  return (right.source_segment_ids ?? [right.id]).some((id) => leftIds.has(id));
}

function overlaps(checkIn: string, checkOut: string, booking: CalendarBooking) {
  return booking.check_in < checkOut && booking.check_out > checkIn;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-3 py-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-foreground">{value}</dd>
    </div>
  );
}

function NumberField({
  id,
  label,
  value,
  onChange,
  icon: Icon,
}: {
  id: string;
  label: string;
  value: number;
  onChange: (value: number) => void;
  icon: typeof UserPlus;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={id} className="flex items-center gap-1.5">
        <Icon className="size-3.5 text-muted-foreground" />
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        value={value}
        onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))}
      />
    </div>
  );
}

function PaymentDialog({
  orderTotal,
  onOpenChange,
  onConfirm,
}: {
  orderTotal: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: RecordPaymentInput) => void;
}) {
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [amount, setAmount] = useState(String(Math.max(1, Math.round(orderTotal * 0.3))));
  const [paymentType, setPaymentType] = useState<PaymentType>("deposit");
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>("bank_transfer");
  const [receivedAt, setReceivedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const numericAmount = Number(amount.replace(/,/g, ""));
  const isValid = Number.isFinite(numericAmount) && numericAmount > 0 && Boolean(receivedAt);

  function submitForm(event: FormEvent) {
    event.preventDefault();
    if (isValid) setStep("confirm");
  }

  function confirm() {
    if (!isValid) return;
    onConfirm({ amount: numericAmount, paymentType, paymentMethod, receivedAt });
    onOpenChange(false);
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>登記付款</DialogTitle>
          <DialogDescription>
            {step === "form" ? "填寫實際收到的款項與日期。" : "請確認這次修改是否正確。"}
          </DialogDescription>
        </DialogHeader>

        {step === "form" ? (
          <form onSubmit={submitForm} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="payment-amount">金額</Label>
              <Input
                id="payment-amount"
                inputMode="numeric"
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
                placeholder="例如 2000"
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label>款項類型</Label>
                <Select value={paymentType} onValueChange={(value) => setPaymentType(value as PaymentType)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="deposit">訂金</SelectItem>
                    <SelectItem value="balance">尾款</SelectItem>
                    <SelectItem value="other">其他款項</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>付款方式</Label>
                <Select value={paymentMethod} onValueChange={(value) => setPaymentMethod(value as PaymentMethod)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">現金</SelectItem>
                    <SelectItem value="bank_transfer">匯款</SelectItem>
                    <SelectItem value="credit_card">信用卡</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="payment-date">實際收款日</Label>
              <Input
                id="payment-date"
                type="date"
                value={receivedAt}
                onChange={(event) => setReceivedAt(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
              <Button type="submit" disabled={!isValid}>下一步</Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border bg-muted/35 p-4 text-sm">
              <div className="flex items-center justify-between py-1"><span className="text-muted-foreground">金額</span><strong>{formatMoney(numericAmount)}</strong></div>
              <div className="flex items-center justify-between py-1"><span className="text-muted-foreground">款項</span><strong>{PAYMENT_TYPE_LABELS[paymentType]}</strong></div>
              <div className="flex items-center justify-between py-1"><span className="text-muted-foreground">方式</span><strong>{PAYMENT_METHOD_LABELS[paymentMethod]}</strong></div>
              <div className="flex items-center justify-between py-1"><span className="text-muted-foreground">收款日</span><strong>{formatDate(receivedAt)}</strong></div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("form")}>返回修改</Button>
              <Button onClick={confirm}>是，確認登記</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function EditBookingDialog({
  booking,
  rooms,
  allBookings,
  canViewPrices,
  onOpenChange,
  onConfirm,
}: {
  booking: CalendarBooking;
  rooms: CalendarRoom[];
  allBookings: CalendarBooking[];
  canViewPrices: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: UpdateBookingInput) => boolean;
}) {
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [guestName, setGuestName] = useState(booking.guest_name);
  const [roomId, setRoomId] = useState(booking.room_id);
  const [checkIn, setCheckIn] = useState(booking.check_in);
  const [checkOut, setCheckOut] = useState(booking.check_out);
  const [roomRate, setRoomRate] = useState(String(booking.room_rate));
  const [extraGuestCount, setExtraGuestCount] = useState(booking.extra_guest_count);
  const [extraBedCount, setExtraBedCount] = useState(booking.extra_bed_count);
  const [petCount, setPetCount] = useState(booking.pet_count);
  const [babySupplies, setBabySupplies] = useState<BabySupply[]>(booking.baby_supplies);
  const [serviceNote, setServiceNote] = useState(booking.service_note ?? "");
  const [submitError, setSubmitError] = useState<string | null>(null);

  const propertyRooms = rooms.filter((room) => room.property_id === booking.property_id);
  const selectedRoom = propertyRooms.find((room) => room.id === roomId) ?? propertyRooms[0];
  const numericRate = Number(roomRate.replace(/,/g, ""));
  const conflictsByRoom = useMemo(() => {
    const result = new Map<string, CalendarBooking>();
    if (!(checkIn && checkOut && checkOut > checkIn)) return result;
    for (const candidate of allBookings) {
      if (
        candidate.reservation_status !== "confirmed" ||
        candidate.property_id !== booking.property_id ||
        sameSourceSegment(candidate, booking) ||
        !overlaps(checkIn, checkOut, candidate)
      ) {
        continue;
      }
      if (!result.has(candidate.room_id)) result.set(candidate.room_id, candidate);
    }
    return result;
  }, [allBookings, booking, checkIn, checkOut]);
  const selectedConflict = selectedRoom ? conflictsByRoom.get(selectedRoom.id) : undefined;
  const isValid =
    guestName.trim().length > 0 &&
    Boolean(selectedRoom) &&
    checkOut > checkIn &&
    Number.isFinite(numericRate) &&
    numericRate >= 0 &&
    !selectedConflict;

  function submitForm(event: FormEvent) {
    event.preventDefault();
    if (selectedConflict) {
      setSubmitError(`${selectedRoom?.label} 在所選日期已被 ${selectedConflict.guest_name} 預訂，無法儲存。`);
      return;
    }
    if (isValid) {
      setSubmitError(null);
      setStep("confirm");
    }
  }

  function confirm() {
    if (!isValid || !selectedRoom) return;
    const accepted = onConfirm({
      guestName: guestName.trim(),
      roomId: selectedRoom.id,
      roomNumber: selectedRoom.room_number,
      checkIn,
      checkOut,
      roomRate: numericRate,
      extraGuestCount,
      extraBedCount,
      petCount,
      babySupplies,
      serviceNote: serviceNote.trim(),
    });
    if (accepted) onOpenChange(false);
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>編輯訂單資料</DialogTitle>
          <DialogDescription>
            {step === "form"
              ? "修改住宿與服務需求；已被占用的房間會直接標示並禁止選取。"
              : "請確認日期、房間、金額與服務需求。"}
          </DialogDescription>
        </DialogHeader>

        {step === "form" ? (
          <form onSubmit={submitForm} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="edit-guest">房客姓名</Label>
              <Input id="edit-guest" value={guestName} onChange={(event) => setGuestName(event.target.value)} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="edit-check-in">入住日</Label>
                <Input id="edit-check-in" type="date" value={checkIn} onChange={(event) => setCheckIn(event.target.value)} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-check-out">退房日</Label>
                <Input id="edit-check-out" type="date" value={checkOut} onChange={(event) => setCheckOut(event.target.value)} />
              </div>
            </div>

            <div className="space-y-2">
              <Label>房間</Label>
              <Select value={roomId} onValueChange={setRoomId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {propertyRooms.map((room) => {
                    const conflict = conflictsByRoom.get(room.id);
                    return (
                      <SelectItem key={room.id} value={room.id} disabled={Boolean(conflict)}>
                        {room.label}{conflict ? ` · 已被 ${conflict.guest_name} 預訂` : " · 可使用"}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>
              {conflictsByRoom.size > 0 && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-950">
                  <p className="flex items-center gap-1.5 font-semibold"><AlertTriangle className="size-3.5" />所選日期已有房間被占用</p>
                  <p className="mt-1">
                    {[...conflictsByRoom.entries()]
                      .map(([conflictRoomId, conflict]) => `${propertyRooms.find((room) => room.id === conflictRoomId)?.label ?? conflictRoomId}（${conflict.guest_name}）`)
                      .join("、")}
                  </p>
                </div>
              )}
              {selectedConflict && (
                <p className="text-xs font-medium text-destructive">
                  {selectedRoom?.label} 與 {selectedConflict.guest_name} 的住宿日期衝突。
                </p>
              )}
            </div>

            {canViewPrices && (
              <div className="space-y-2">
                <Label htmlFor="edit-rate">房費</Label>
                <Input id="edit-rate" inputMode="numeric" value={roomRate} onChange={(event) => setRoomRate(event.target.value)} />
              </div>
            )}

            <section className="space-y-3 rounded-2xl border p-4">
              <div>
                <h3 className="font-semibold">入住服務需求</h3>
                <p className="text-xs text-muted-foreground">使用結構化欄位，備註只補充特殊細節。</p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <NumberField id="extra-guests" label="加人" value={extraGuestCount} onChange={setExtraGuestCount} icon={UserPlus} />
                <NumberField id="extra-beds" label="加床" value={extraBedCount} onChange={setExtraBedCount} icon={BedSingle} />
                <NumberField id="pets" label="寵物" value={petCount} onChange={setPetCount} icon={PawPrint} />
              </div>
              <div className="space-y-2">
                <Label className="flex items-center gap-1.5"><Baby className="size-3.5 text-muted-foreground" />嬰兒用品</Label>
                <div className="grid gap-2 sm:grid-cols-2">
                  {BABY_SUPPLIES.map((supply) => {
                    const checked = babySupplies.includes(supply);
                    return (
                      <label key={supply} className="flex cursor-pointer items-center gap-2 rounded-xl border px-3 py-2.5 text-sm">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setBabySupplies((current) =>
                              checked ? current.filter((item) => item !== supply) : [...current, supply],
                            )
                          }
                          className="size-4"
                        />
                        {BABY_SUPPLY_LABELS[supply]}
                      </label>
                    );
                  })}
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="service-note">服務備註</Label>
                <textarea
                  id="service-note"
                  value={serviceNote}
                  onChange={(event) => setServiceNote(event.target.value)}
                  placeholder="例如：澡盆放 301 房門口、寵物不進床鋪"
                  className="min-h-24 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            </section>

            {submitError && <p className="text-sm font-medium text-destructive">{submitError}</p>}
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>取消</Button>
              <Button type="submit" disabled={!isValid}>下一步</Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border bg-muted/35 p-4 text-sm">
              <p className="font-semibold">{guestName.trim()}</p>
              <p className="mt-2 text-muted-foreground">
                {selectedRoom?.label} · {formatDate(checkIn)}–{formatDate(checkOut)} · {dayDifference(checkOut, checkIn)} 晚
              </p>
              {canViewPrices && <p className="mt-1 font-semibold">{formatMoney(numericRate)}</p>}
              {(extraGuestCount > 0 || extraBedCount > 0 || petCount > 0 || babySupplies.length > 0) && (
                <p className="mt-2 text-muted-foreground">
                  {[
                    extraGuestCount > 0 ? `加人 ${extraGuestCount}` : null,
                    extraBedCount > 0 ? `加床 ${extraBedCount}` : null,
                    petCount > 0 ? `寵物 ${petCount}` : null,
                    ...babySupplies.map((supply) => BABY_SUPPLY_LABELS[supply]),
                  ].filter(Boolean).join(" · ")}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("form")}>返回修改</Button>
              <Button onClick={confirm}>是，確認修改</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CancelBookingDialog({
  onOpenChange,
  onConfirm,
}: {
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>取消這張預訂？</DialogTitle>
          <DialogDescription>取消後會從目前房況中移除，並保留取消時間與異動紀錄。</DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="cancel-reason">取消原因（選填）</Label>
          <Input id="cancel-reason" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="例如：客人自行取消" />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>返回</Button>
          <Button
            variant="destructive"
            onClick={() => {
              onConfirm(reason.trim());
              onOpenChange(false);
            }}
          >
            是，取消預訂
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function BookingDetailsPanel({
  booking,
  orderSegments,
  allBookings,
  rooms,
  permissions,
  onClose,
  onRecordPayment,
  onUpdateBooking,
  onCancelBooking,
}: {
  booking: CalendarBooking | null;
  orderSegments: CalendarBooking[];
  allBookings: CalendarBooking[];
  rooms: CalendarRoom[];
  permissions: WorkspacePermissions;
  onClose: () => void;
  onRecordPayment: (input: RecordPaymentInput) => void;
  onUpdateBooking: (input: UpdateBookingInput) => boolean;
  onCancelBooking: (reason: string) => void;
}) {
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const orderTotal = useMemo(
    () => orderSegments.reduce((sum, segment) => sum + segment.room_rate, 0),
    [orderSegments],
  );
  const recordedPayments = permissions.view_prices ? booking?.payments ?? [] : [];
  const recordedAmount = recordedPayments.reduce((sum, payment) => sum + payment.amount, 0);
  const requirementLabels = booking ? serviceRequirementLabels(booking) : [];

  return (
    <>
      <Sheet open={booking !== null} onOpenChange={(open) => !open && onClose()}>
        <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-xl">
          <SheetHeader className="border-b px-5 py-5 text-left">
            <div className="min-w-0 pr-8">
              <SheetTitle className="truncate text-xl">{booking?.guest_name ?? "訂單資料"}</SheetTitle>
              <SheetDescription className="mt-1">
                {booking
                  ? `${booking.property_name} · ${booking.room_number} · ${formatDate(booking.check_in)}–${formatDate(booking.check_out)}`
                  : ""}
              </SheetDescription>
            </div>
          </SheetHeader>

          {booking && (
            <div className="space-y-5 px-5 py-5">
              <div
                className={cn(
                  "rounded-xl border px-3 py-2.5 text-sm font-semibold",
                  booking.reservation_status === "cancelled"
                    ? "border-slate-200 bg-slate-100 text-slate-700"
                    : PLATFORM_STYLES[booking.platform] ?? PLATFORM_STYLES.other,
                )}
              >
                {booking.reservation_status === "cancelled"
                  ? "已取消"
                  : `${PLATFORM_LABELS[booking.platform] ?? booking.platform} · ${PAYMENT_LABELS[booking.payment_status]}`}
              </div>

              {booking.reservation_status !== "cancelled" &&
                (permissions.record_payments || permissions.edit_bookings) && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {permissions.record_payments && permissions.view_prices && (
                      <Button className="justify-start" onClick={() => setPaymentOpen(true)}>
                        <ReceiptText className="size-4" />
                        登記訂金／付款
                      </Button>
                    )}
                    {permissions.edit_bookings && (
                      <Button variant="outline" className="justify-start" onClick={() => setEditOpen(true)}>
                        <CalendarClock className="size-4" />
                        編輯訂單資料
                      </Button>
                    )}
                  </div>
                )}

              <section>
                <h3 className="text-sm font-semibold">訂單資訊</h3>
                <dl className="mt-2 divide-y rounded-xl border px-4">
                  <DetailRow label="旅宿" value={booking.property_name} />
                  <DetailRow label="房間" value={booking.room_number} />
                  <DetailRow label="入住" value={formatDate(booking.check_in)} />
                  <DetailRow label="退房" value={formatDate(booking.check_out)} />
                  <DetailRow label="住宿晚數" value={`${dayDifference(booking.check_out, booking.check_in)} 晚`} />
                  <DetailRow label="本筆房費" value={formatMoney(booking.room_rate, permissions.view_prices)} />
                  <DetailRow label="訂單總額" value={formatMoney(orderTotal, permissions.view_prices)} />
                  <DetailRow label="預訂日" value={formatDate(booking.booked_at)} />
                  <DetailRow label="訂單編號" value={booking.order_id} />
                  <DetailRow label="外部編號" value={booking.external_order_no ?? "—"} />
                  <DetailRow label="原始備註" value={booking.notes ?? "—"} />
                </dl>
              </section>

              <section>
                <div className="flex items-center gap-2">
                  <Baby className="size-4" />
                  <h3 className="text-sm font-semibold">入住服務需求</h3>
                </div>
                <div className="mt-2 rounded-xl border p-4">
                  {requirementLabels.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {requirementLabels.map((label) => (
                        <span key={label} className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium">{label}</span>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-muted-foreground">沒有加人、加床、寵物或嬰兒用品需求。</p>
                  )}
                  {booking.service_note && (
                    <p className="mt-3 border-t pt-3 text-sm leading-6 text-muted-foreground">{booking.service_note}</p>
                  )}
                </div>
              </section>

              {permissions.view_prices && (
                <section>
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-semibold"><CircleDollarSign className="size-4" />付款紀錄</h3>
                    {recordedPayments.length > 0 && (
                      <span className="text-xs font-medium text-muted-foreground">本次已登記 {formatMoney(recordedAmount)}</span>
                    )}
                  </div>
                  <div className="mt-2 space-y-2">
                    {recordedPayments.length === 0 ? (
                      <div className="rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground">
                        匯入資料可能只含付款狀態；新增的逐筆付款會顯示在這裡。
                      </div>
                    ) : (
                      recordedPayments
                        .slice()
                        .sort((a, b) => b.received_at.localeCompare(a.received_at))
                        .map((payment) => {
                          const MethodIcon = payment.payment_method === "cash" ? Banknote : payment.payment_method === "credit_card" ? CreditCard : Landmark;
                          return (
                            <div key={payment.id} className="flex items-center gap-3 rounded-xl border px-3 py-3">
                              <span className="flex size-9 items-center justify-center rounded-lg bg-muted"><MethodIcon className="size-4" /></span>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold">{PAYMENT_TYPE_LABELS[payment.payment_type]} · {formatMoney(payment.amount)}</p>
                                <p className="text-xs text-muted-foreground">{formatDate(payment.received_at)} · {PAYMENT_METHOD_LABELS[payment.payment_method]}</p>
                              </div>
                            </div>
                          );
                        })
                    )}
                  </div>
                </section>
              )}

              {booking.audit_log.length > 0 && (
                <section>
                  <h3 className="flex items-center gap-2 text-sm font-semibold"><History className="size-4" />最近異動</h3>
                  <div className="mt-2 space-y-2">
                    {booking.audit_log
                      .slice()
                      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
                      .map((event) => (
                        <div key={event.id} className="rounded-xl border px-3 py-3">
                          <p className="text-sm font-medium">{event.summary}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{new Date(event.occurred_at).toLocaleString("zh-TW")}</p>
                        </div>
                      ))}
                  </div>
                </section>
              )}

              {booking.reservation_status !== "cancelled" && permissions.cancel_bookings && (
                <div className="border-t pt-4">
                  <Button
                    variant="outline"
                    className="w-full justify-start border-destructive/30 text-destructive hover:bg-destructive/5 hover:text-destructive"
                    onClick={() => setCancelOpen(true)}
                  >
                    <Trash2 className="size-4" />
                    取消預訂
                  </Button>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      {booking && paymentOpen && (
        <PaymentDialog
          orderTotal={orderTotal}
          onOpenChange={setPaymentOpen}
          onConfirm={onRecordPayment}
        />
      )}
      {booking && editOpen && (
        <EditBookingDialog
          booking={booking}
          rooms={rooms}
          allBookings={allBookings}
          canViewPrices={permissions.view_prices}
          onOpenChange={setEditOpen}
          onConfirm={onUpdateBooking}
        />
      )}
      {booking && cancelOpen && (
        <CancelBookingDialog onOpenChange={setCancelOpen} onConfirm={onCancelBooking} />
      )}
    </>
  );
}
