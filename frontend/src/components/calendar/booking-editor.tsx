"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Baby,
  Banknote,
  Bed,
  CalendarClock,
  Check,
  CircleDollarSign,
  CreditCard,
  History,
  Landmark,
  LoaderCircle,
  PawPrint,
  ReceiptText,
  Trash2,
  Users,
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
import { Textarea } from "@/components/ui/textarea";
import { apiClient } from "@/lib/api-client";
import type { RolePermissions } from "@/lib/access-control";
import { cn } from "@/lib/utils";

import type {
  BabySupplyKey,
  CalendarBooking,
  CalendarResponse,
  CalendarRoom,
  PaymentMethod,
  PaymentType,
} from "./calendar-types";
import {
  BABY_SUPPLY_LABELS,
  PAYMENT_METHOD_LABELS,
  PAYMENT_TYPE_LABELS,
  PLATFORM_LABELS,
  PLATFORM_STYLES,
  formatDate,
  formatMoney,
  stayNightCount,
} from "./calendar-utils";

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
  babySupplies: BabySupplyKey[];
  serviceNote: string;
};

const PAYMENT_LABELS = {
  paid: "已付清",
  deposit: "已付訂金",
  unpaid: "未付款",
} as const;

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid grid-cols-[88px_1fr] gap-3 py-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words font-medium text-foreground">{value}</dd>
    </div>
  );
}

function countValue(value: string) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 0;
}

function PaymentDialog({
  open,
  orderTotal,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  orderTotal: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: RecordPaymentInput) => void;
}) {
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [amount, setAmount] = useState("");
  const [paymentType, setPaymentType] = useState<PaymentType>("deposit");
  const [paymentMethod, setPaymentMethod] =
    useState<PaymentMethod>("bank_transfer");
  const [receivedAt, setReceivedAt] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const numericAmount = Number(amount.replace(/,/g, ""));
  const isValid =
    Number.isFinite(numericAmount) && numericAmount > 0 && Boolean(receivedAt);

  useEffect(() => {
    if (!open) return;
    setStep("form");
    setAmount(String(Math.max(1, Math.round(orderTotal * 0.3))));
    setPaymentType("deposit");
    setPaymentMethod("bank_transfer");
    setReceivedAt(new Date().toISOString().slice(0, 10));
  }, [open, orderTotal]);

  function submitForm(event: FormEvent) {
    event.preventDefault();
    if (isValid) setStep("confirm");
  }

  function confirm() {
    if (!isValid) return;
    onConfirm({
      amount: numericAmount,
      paymentType,
      paymentMethod,
      receivedAt,
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>登記付款</DialogTitle>
          <DialogDescription>
            {step === "form"
              ? "填寫實際收到的款項、方式與日期。"
              : "請確認這次修改是否正確。"}
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
                <Select
                  value={paymentType}
                  onValueChange={(value) => setPaymentType(value as PaymentType)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="deposit">訂金</SelectItem>
                    <SelectItem value="balance">尾款</SelectItem>
                    <SelectItem value="other">其他款項</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>付款方式</Label>
                <Select
                  value={paymentMethod}
                  onValueChange={(value) =>
                    setPaymentMethod(value as PaymentMethod)
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
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
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={!isValid}>
                下一步
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border bg-muted/35 p-4 text-sm">
              <div className="flex items-center justify-between py-1">
                <span className="text-muted-foreground">金額</span>
                <strong>{formatMoney(numericAmount)}</strong>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-muted-foreground">款項</span>
                <strong>{PAYMENT_TYPE_LABELS[paymentType]}</strong>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-muted-foreground">方式</span>
                <strong>{PAYMENT_METHOD_LABELS[paymentMethod]}</strong>
              </div>
              <div className="flex items-center justify-between py-1">
                <span className="text-muted-foreground">收款日</span>
                <strong>{formatDate(receivedAt)}</strong>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("form")}>
                返回修改
              </Button>
              <Button onClick={confirm}>是，確認登記</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

type AvailabilityState = "idle" | "loading" | "ready" | "error";

function EditBookingDialog({
  open,
  booking,
  rooms,
  viewPrices,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  booking: CalendarBooking;
  rooms: CalendarRoom[];
  viewPrices: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (input: UpdateBookingInput) => void;
}) {
  const [step, setStep] = useState<"form" | "confirm">("form");
  const [guestName, setGuestName] = useState(booking.guest_name);
  const [roomId, setRoomId] = useState(booking.room_id);
  const [checkIn, setCheckIn] = useState(booking.check_in);
  const [checkOut, setCheckOut] = useState(booking.check_out);
  const [roomRate, setRoomRate] = useState(String(booking.room_rate));
  const [extraGuestCount, setExtraGuestCount] = useState(
    String(booking.extra_guest_count ?? 0),
  );
  const [extraBedCount, setExtraBedCount] = useState(
    String(booking.extra_bed_count ?? 0),
  );
  const [petCount, setPetCount] = useState(String(booking.pet_count ?? 0));
  const [babySupplies, setBabySupplies] = useState<BabySupplyKey[]>(
    booking.baby_supplies ?? [],
  );
  const [serviceNote, setServiceNote] = useState(booking.service_note ?? "");
  const [availabilityState, setAvailabilityState] =
    useState<AvailabilityState>("idle");
  const [availabilityBookings, setAvailabilityBookings] = useState<
    CalendarBooking[]
  >([]);
  const [availabilityError, setAvailabilityError] = useState<string | null>(null);

  const propertyRooms = useMemo(
    () => rooms.filter((room) => room.property_id === booking.property_id),
    [booking.property_id, rooms],
  );
  const selectedRoom =
    propertyRooms.find((room) => room.id === roomId) ?? propertyRooms[0];
  const dateRangeIsValid = Boolean(checkIn && checkOut && checkOut > checkIn);

  useEffect(() => {
    if (!open) return;
    setStep("form");
    setGuestName(booking.guest_name);
    setRoomId(booking.room_id);
    setCheckIn(booking.check_in);
    setCheckOut(booking.check_out);
    setRoomRate(String(booking.room_rate));
    setExtraGuestCount(String(booking.extra_guest_count ?? 0));
    setExtraBedCount(String(booking.extra_bed_count ?? 0));
    setPetCount(String(booking.pet_count ?? 0));
    setBabySupplies(booking.baby_supplies ?? []);
    setServiceNote(booking.service_note ?? "");
    setAvailabilityState("idle");
    setAvailabilityBookings([]);
    setAvailabilityError(null);
  }, [booking, open]);

  useEffect(() => {
    if (!open || !dateRangeIsValid) return;

    let active = true;
    const timer = window.setTimeout(async () => {
      setAvailabilityState("loading");
      setAvailabilityError(null);
      try {
        const response = await apiClient.get<CalendarResponse>(
          `/bookings/calendar?start=${checkIn}&end=${checkOut}`,
        );
        if (!active) return;
        setAvailabilityBookings(response.bookings);
        setAvailabilityState("ready");
      } catch (error) {
        if (!active) return;
        setAvailabilityBookings([]);
        setAvailabilityError(
          error instanceof Error ? error.message : "無法確認目前房況",
        );
        setAvailabilityState("error");
      }
    }, 180);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [checkIn, checkOut, dateRangeIsValid, open]);

  const roomConflicts = useMemo(() => {
    const conflicts = new Map<string, CalendarBooking>();
    if (!dateRangeIsValid) return conflicts;

    for (const room of propertyRooms) {
      const conflict = availabilityBookings.find(
        (candidate) =>
          candidate.order_id !== booking.order_id &&
          candidate.reservation_status === "confirmed" &&
          candidate.property_id === booking.property_id &&
          candidate.room_id === room.id &&
          candidate.check_in < checkOut &&
          candidate.check_out > checkIn,
      );
      if (conflict) conflicts.set(room.id, conflict);
    }
    return conflicts;
  }, [
    availabilityBookings,
    booking.order_id,
    booking.property_id,
    checkIn,
    checkOut,
    dateRangeIsValid,
    propertyRooms,
  ]);

  const selectedConflict = roomConflicts.get(roomId) ?? null;
  const unavailableRooms = propertyRooms.filter((room) =>
    roomConflicts.has(room.id),
  );
  const numericRate = Number(roomRate.replace(/,/g, ""));
  const availabilityIsReady = availabilityState === "ready";
  const isValid =
    guestName.trim().length > 0 &&
    Boolean(selectedRoom) &&
    dateRangeIsValid &&
    availabilityIsReady &&
    !selectedConflict &&
    Number.isFinite(numericRate) &&
    numericRate >= 0;

  function toggleSupply(supply: BabySupplyKey) {
    setBabySupplies((current) =>
      current.includes(supply)
        ? current.filter((item) => item !== supply)
        : [...current, supply],
    );
  }

  function submitForm(event: FormEvent) {
    event.preventDefault();
    if (isValid) setStep("confirm");
  }

  function confirm() {
    if (!isValid || !selectedRoom) return;
    onConfirm({
      guestName: guestName.trim(),
      roomId: selectedRoom.id,
      roomNumber: selectedRoom.room_number,
      checkIn,
      checkOut,
      roomRate: numericRate,
      extraGuestCount: countValue(extraGuestCount),
      extraBedCount: countValue(extraBedCount),
      petCount: countValue(petCount),
      babySupplies,
      serviceNote: serviceNote.trim(),
    });
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92dvh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>編輯訂單資料</DialogTitle>
          <DialogDescription>
            {step === "form"
              ? "房間選單會依入住區間即時標示可用與衝突房間。"
              : "請確認住宿、房間與入住需求。"}
          </DialogDescription>
        </DialogHeader>

        {step === "form" ? (
          <form onSubmit={submitForm} className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="edit-guest">房客姓名</Label>
              <Input
                id="edit-guest"
                value={guestName}
                onChange={(event) => setGuestName(event.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="edit-check-in">入住日</Label>
                <Input
                  id="edit-check-in"
                  type="date"
                  value={checkIn}
                  onChange={(event) => setCheckIn(event.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-check-out">退房日</Label>
                <Input
                  id="edit-check-out"
                  type="date"
                  value={checkOut}
                  onChange={(event) => setCheckOut(event.target.value)}
                />
              </div>
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>房間</Label>
                {availabilityState === "loading" && (
                  <span className="flex items-center gap-1 text-xs text-muted-foreground">
                    <LoaderCircle className="size-3 animate-spin" />
                    檢查房況
                  </span>
                )}
              </div>
              <Select value={roomId} onValueChange={setRoomId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {propertyRooms.map((room) => {
                    const conflict = roomConflicts.get(room.id);
                    return (
                      <SelectItem key={room.id} value={room.id} disabled={Boolean(conflict)}>
                        {room.label}
                        {conflict ? ` · 已被 ${conflict.guest_name} 預訂` : " · 可用"}
                      </SelectItem>
                    );
                  })}
                </SelectContent>
              </Select>

              {availabilityError && (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  無法確認房況：{availabilityError}。為避免超賣，目前不能儲存。
                </p>
              )}
              {selectedConflict && (
                <p className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  {selectedRoom?.label} 與 {selectedConflict.guest_name}（
                  {formatDate(selectedConflict.check_in)}–{formatDate(selectedConflict.check_out)}）重疊，已擋下修改。
                </p>
              )}
              {availabilityState === "ready" && unavailableRooms.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  此區間不可用：{unavailableRooms.map((room) => room.label).join("、")}
                </p>
              )}
            </div>

            {viewPrices && (
              <div className="space-y-2">
                <Label htmlFor="edit-rate">房費</Label>
                <Input
                  id="edit-rate"
                  inputMode="numeric"
                  value={roomRate}
                  onChange={(event) => setRoomRate(event.target.value)}
                />
              </div>
            )}

            <section className="space-y-3 rounded-xl border p-4">
              <div>
                <h3 className="font-semibold">入住需求</h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  加人、加床與寵物使用結構化數量；特殊細節再寫入備註。
                </p>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div className="space-y-2">
                  <Label htmlFor="extra-guests">加人</Label>
                  <Input
                    id="extra-guests"
                    type="number"
                    min={0}
                    value={extraGuestCount}
                    onChange={(event) => setExtraGuestCount(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="extra-beds">加床</Label>
                  <Input
                    id="extra-beds"
                    type="number"
                    min={0}
                    value={extraBedCount}
                    onChange={(event) => setExtraBedCount(event.target.value)}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="pets">寵物</Label>
                  <Input
                    id="pets"
                    type="number"
                    min={0}
                    value={petCount}
                    onChange={(event) => setPetCount(event.target.value)}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>嬰兒用品</Label>
                <div className="flex flex-wrap gap-2">
                  {(Object.keys(BABY_SUPPLY_LABELS) as BabySupplyKey[]).map((supply) => {
                    const selected = babySupplies.includes(supply);
                    return (
                      <button
                        key={supply}
                        type="button"
                        onClick={() => toggleSupply(supply)}
                        className={cn(
                          "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium",
                          selected
                            ? "border-primary bg-primary text-primary-foreground"
                            : "bg-background text-muted-foreground",
                        )}
                      >
                        {selected && <Check className="size-3" />}
                        {BABY_SUPPLY_LABELS[supply]}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="service-note">需求備註</Label>
                <Textarea
                  id="service-note"
                  value={serviceNote}
                  onChange={(event) => setServiceNote(event.target.value)}
                  placeholder="例如：嬰兒床需放在靠窗側、寵物不進房等"
                />
              </div>
            </section>

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
              >
                取消
              </Button>
              <Button type="submit" disabled={!isValid}>
                下一步
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="rounded-xl border bg-muted/35 p-4 text-sm">
              <p className="font-semibold">{guestName.trim()}</p>
              <p className="mt-2 text-muted-foreground">
                {selectedRoom?.label} · {formatDate(checkIn)}–{formatDate(checkOut)} · {Math.max(1, stayNightCount({ ...booking, check_in: checkIn, check_out: checkOut }))} 晚
              </p>
              {viewPrices && <p className="mt-1 font-semibold">{formatMoney(numericRate)}</p>}
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {countValue(extraGuestCount) > 0 && <span>加人 {countValue(extraGuestCount)}</span>}
                {countValue(extraBedCount) > 0 && <span>加床 {countValue(extraBedCount)}</span>}
                {countValue(petCount) > 0 && <span>寵物 {countValue(petCount)}</span>}
                {babySupplies.map((supply) => (
                  <span key={supply}>{BABY_SUPPLY_LABELS[supply]}</span>
                ))}
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep("form")}>
                返回修改
              </Button>
              <Button onClick={confirm}>是，確認修改</Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CancelBookingDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");

  useEffect(() => {
    if (open) setReason("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>取消這張預訂？</DialogTitle>
          <DialogDescription>
            取消後會從目前房況中移除，並保留取消時間與異動紀錄。
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor="cancel-reason">取消原因（選填）</Label>
          <Input
            id="cancel-reason"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="例如：客人自行取消"
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            返回
          </Button>
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

function RequirementSummary({ booking }: { booking: CalendarBooking }) {
  const supplies = booking.baby_supplies ?? [];
  const hasRequirements =
    (booking.extra_guest_count ?? 0) > 0 ||
    (booking.extra_bed_count ?? 0) > 0 ||
    (booking.pet_count ?? 0) > 0 ||
    supplies.length > 0 ||
    Boolean(booking.service_note);

  if (!hasRequirements) {
    return (
      <div className="rounded-xl border border-dashed px-4 py-4 text-sm text-muted-foreground">
        無特殊入住需求
      </div>
    );
  }

  return (
    <div className="grid gap-2 sm:grid-cols-2">
      {(booking.extra_guest_count ?? 0) > 0 && (
        <div className="flex items-center gap-2 rounded-xl border px-3 py-3 text-sm">
          <Users className="size-4" />
          加人 {booking.extra_guest_count} 位
        </div>
      )}
      {(booking.extra_bed_count ?? 0) > 0 && (
        <div className="flex items-center gap-2 rounded-xl border px-3 py-3 text-sm">
          <Bed className="size-4" />
          加床 {booking.extra_bed_count} 張
        </div>
      )}
      {(booking.pet_count ?? 0) > 0 && (
        <div className="flex items-center gap-2 rounded-xl border px-3 py-3 text-sm">
          <PawPrint className="size-4" />
          寵物 {booking.pet_count} 隻
        </div>
      )}
      {supplies.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border px-3 py-3 text-sm sm:col-span-2">
          <Baby className="mt-0.5 size-4 shrink-0" />
          <span>{supplies.map((supply) => BABY_SUPPLY_LABELS[supply]).join("、")}</span>
        </div>
      )}
      {booking.service_note && (
        <div className="rounded-xl border px-3 py-3 text-sm sm:col-span-2">
          {booking.service_note}
        </div>
      )}
    </div>
  );
}

export function BookingDetailsPanel({
  booking,
  orderSegments,
  rooms,
  permissions,
  onClose,
  onRecordPayment,
  onUpdateBooking,
  onCancelBooking,
}: {
  booking: CalendarBooking | null;
  orderSegments: CalendarBooking[];
  rooms: CalendarRoom[];
  permissions: RolePermissions;
  onClose: () => void;
  onRecordPayment: (input: RecordPaymentInput) => void;
  onUpdateBooking: (input: UpdateBookingInput) => void;
  onCancelBooking: (reason: string) => void;
}) {
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const orderTotal = useMemo(
    () => orderSegments.reduce((sum, segment) => sum + segment.room_rate, 0),
    [orderSegments],
  );
  const recordedPayments = booking?.payments ?? [];
  const recordedAmount = recordedPayments.reduce(
    (sum, payment) => sum + payment.amount,
    0,
  );

  return (
    <>
      <Sheet open={booking !== null} onOpenChange={(open) => !open && onClose()}>
        <SheetContent className="w-full overflow-y-auto p-0 sm:max-w-xl">
          <SheetHeader className="border-b px-5 py-5 text-left">
            <div className="pr-8">
              <SheetTitle className="truncate text-xl">
                {booking?.guest_name ?? "訂單資料"}
              </SheetTitle>
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
                  : `${PLATFORM_LABELS[booking.platform] ?? booking.platform} · ${PAYMENT_LABELS[booking.payment_status]}${stayNightCount(booking) > 1 ? ` · 連住 ${stayNightCount(booking)} 晚` : ""}`}
              </div>

              {booking.reservation_status !== "cancelled" &&
                (permissions.recordPayments || permissions.editBookings) && (
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {permissions.recordPayments && permissions.viewPrices && (
                      <Button className="justify-start" onClick={() => setPaymentOpen(true)}>
                        <ReceiptText className="size-4" />
                        登記付款
                      </Button>
                    )}
                    {permissions.editBookings && (
                      <Button
                        variant="outline"
                        className="justify-start"
                        onClick={() => setEditOpen(true)}
                      >
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
                  <DetailRow
                    label="住宿晚數"
                    value={`${stayNightCount(booking)} 晚`}
                  />
                  {permissions.viewPrices && (
                    <>
                      <DetailRow label="本筆房費" value={formatMoney(booking.room_rate)} />
                      <DetailRow label="訂單總額" value={formatMoney(orderTotal)} />
                    </>
                  )}
                  <DetailRow label="預訂日" value={formatDate(booking.booked_at)} />
                  <DetailRow label="訂單編號" value={booking.order_id} />
                  <DetailRow label="外部編號" value={booking.external_order_no ?? "—"} />
                  <DetailRow label="原始備註" value={booking.notes ?? "—"} />
                </dl>
              </section>

              <section>
                <h3 className="text-sm font-semibold">入住需求</h3>
                <div className="mt-2">
                  <RequirementSummary booking={booking} />
                </div>
              </section>

              {permissions.viewPrices && (
                <section>
                  <div className="flex items-center justify-between">
                    <h3 className="flex items-center gap-2 text-sm font-semibold">
                      <CircleDollarSign className="size-4" />
                      付款紀錄
                    </h3>
                    {recordedPayments.length > 0 && (
                      <span className="text-xs font-medium text-muted-foreground">
                        已登記 {formatMoney(recordedAmount)}
                      </span>
                    )}
                  </div>
                  <div className="mt-2 space-y-2">
                    {recordedPayments.length === 0 ? (
                      <div className="rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground">
                        匯入資料目前只含付款狀態；新增的逐筆付款會顯示在這裡。
                      </div>
                    ) : (
                      recordedPayments
                        .slice()
                        .sort((a, b) => b.received_at.localeCompare(a.received_at))
                        .map((payment) => {
                          const MethodIcon =
                            payment.payment_method === "cash"
                              ? Banknote
                              : payment.payment_method === "credit_card"
                                ? CreditCard
                                : Landmark;
                          return (
                            <div
                              key={payment.id}
                              className="flex items-center gap-3 rounded-xl border px-3 py-3"
                            >
                              <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
                                <MethodIcon className="size-4" />
                              </span>
                              <div className="min-w-0 flex-1">
                                <p className="text-sm font-semibold">
                                  {PAYMENT_TYPE_LABELS[payment.payment_type]} · {formatMoney(payment.amount)}
                                </p>
                                <p className="text-xs text-muted-foreground">
                                  {formatDate(payment.received_at)} · {PAYMENT_METHOD_LABELS[payment.payment_method]}
                                </p>
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
                  <h3 className="flex items-center gap-2 text-sm font-semibold">
                    <History className="size-4" />
                    最近異動
                  </h3>
                  <div className="mt-2 space-y-2">
                    {booking.audit_log
                      .slice()
                      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
                      .map((event) => (
                        <div key={event.id} className="rounded-xl border px-3 py-3">
                          <p className="text-sm font-medium">{event.summary}</p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            {new Date(event.occurred_at).toLocaleString("zh-TW")}
                          </p>
                        </div>
                      ))}
                  </div>
                </section>
              )}

              {booking.reservation_status !== "cancelled" &&
                permissions.cancelBookings && (
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

      {booking && (
        <>
          {permissions.recordPayments && permissions.viewPrices && (
            <PaymentDialog
              open={paymentOpen}
              orderTotal={orderTotal}
              onOpenChange={setPaymentOpen}
              onConfirm={onRecordPayment}
            />
          )}
          {permissions.editBookings && (
            <EditBookingDialog
              open={editOpen}
              booking={booking}
              rooms={rooms}
              viewPrices={permissions.viewPrices}
              onOpenChange={setEditOpen}
              onConfirm={onUpdateBooking}
            />
          )}
          {permissions.cancelBookings && (
            <CancelBookingDialog
              open={cancelOpen}
              onOpenChange={setCancelOpen}
              onConfirm={onCancelBooking}
            />
          )}
        </>
      )}
    </>
  );
}
