"""Outbound-only, versioned host relay client for the owner BFF contract."""

from __future__ import annotations

import asyncio
import hashlib
import json
import secrets
from datetime import UTC, datetime
from typing import Annotated, Any, Literal

import httpx
from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field, StringConstraints, ValidationError

from app.main import AGENT_ID, AdbEmulator, UIAction
from app.oa_workflows import ACTIONS as OA_ACTIONS
from app.oa_workflows import validate_payload

PROTOCOL_VERSION = "1.0"
HEARTBEAT_SECONDS = 15
RETRY_MIN_SECONDS = 2
RETRY_MAX_SECONDS = 60
OPAQUE_MAX_LENGTH = 1000
IdempotencyKey = Annotated[str, StringConstraints(min_length=8, max_length=128)]
OpaqueValue = Annotated[str, StringConstraints(min_length=16, max_length=OPAQUE_MAX_LENGTH)]


def utc_now() -> str:
    return datetime.now(UTC).isoformat()


class ProtocolModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class PairingRedeemRequest(ProtocolModel):
    protocol_version: str = PROTOCOL_VERSION
    pairing_code: Annotated[str, StringConstraints(min_length=8, max_length=128)]
    host_id: str
    agent_id: str = AGENT_ID
    property_id: str
    runtime_version: str = "1.0.0"
    nonce: str = Field(min_length=16, max_length=128)


class PairingRedeemResponse(ProtocolModel):
    protocol_version: str = PROTOCOL_VERSION
    nonce: str = Field(min_length=16, max_length=128)
    host_token: OpaqueValue
    token_expires_at: datetime
    host_id: str
    agent_id: str = AGENT_ID
    property_id: str
    scope: list[str]


class HeartbeatRequest(ProtocolModel):
    protocol_version: str = PROTOCOL_VERSION
    host_id: str
    agent_id: str = AGENT_ID
    property_id: str
    sequence: int = Field(ge=1)
    nonce: str = Field(min_length=16, max_length=128)
    sent_at: datetime
    status: dict[str, Any]


class JobClaimRequest(ProtocolModel):
    protocol_version: str = PROTOCOL_VERSION
    host_id: str
    agent_id: str = AGENT_ID
    property_id: str
    nonce: str = Field(min_length=16, max_length=128)
    wait_seconds: int = Field(ge=0, le=20)
    capabilities: list[str] = Field(default_factory=list)


class ResultEvidence(ProtocolModel):
    snapshot_id: str | None = None
    screenshot_sha256: str | None = None
    visible_effect_confirmed: bool = False
    details: dict[str, Any] = Field(default_factory=dict)


class JobResultRequest(ProtocolModel):
    protocol_version: str = PROTOCOL_VERSION
    host_id: str
    agent_id: str = AGENT_ID
    property_id: str
    job_id: str
    lease_id: str
    idempotency_key: IdempotencyKey
    nonce: str = Field(min_length=16, max_length=128)
    status: Literal["succeeded", "owner_required", "needs_reauth", "blocked", "failed", "partial_success", "unavailable"]
    output: dict[str, Any] | None = None
    evidence: list[ResultEvidence] = Field(default_factory=list)
    error_code: str | None = None
    completed_at: datetime


class ClaimedJob(ProtocolModel):
    protocol_version: str = PROTOCOL_VERSION
    nonce: str = Field(min_length=16, max_length=128)
    job_id: str
    lease_id: str
    lease_expires_at: datetime
    idempotency_key: IdempotencyKey
    agent_id: str = AGENT_ID
    property_id: str
    action: str
    payload: dict[str, Any]
    approval_id: str | None = None
    approval_expires_at: datetime | None = None
    approval_action_sha256: str | None = None
    automation: dict[str, str] | None = None


class HostIdentity(ProtocolModel):
    host_id: str
    agent_id: str = AGENT_ID
    property_id: str
    token: OpaqueValue
    token_expires_at: datetime
    scope: list[str]
    last_sequence: int = 0


class HeartbeatReceipt(ProtocolModel):
    protocol_version: str = PROTOCOL_VERSION
    nonce: str
    host_id: str
    sequence: int
    accepted: bool
    server_time: datetime


class ResultReceipt(ProtocolModel):
    protocol_version: str = PROTOCOL_VERSION
    nonce: str
    job_id: str
    idempotency_key: IdempotencyKey
    accepted: bool
    duplicate: bool = False


class RevocationRequest(ProtocolModel):
    protocol_version: str = PROTOCOL_VERSION
    host_id: str
    agent_id: str = AGENT_ID
    property_id: str
    nonce: str = Field(min_length=16, max_length=128)


class RevocationReceipt(ProtocolModel):
    protocol_version: str = PROTOCOL_VERSION
    nonce: str
    revoked: bool


class PairingClient:
    """Redeem a short-lived owner-issued code over outbound HTTPS once."""

    def __init__(self, base_url: str, client: httpx.AsyncClient | None = None) -> None:
        if not base_url.startswith("https://"):
            raise ValueError("relay_requires_https")
        self.base_url = base_url.rstrip("/")
        self.client = client or httpx.AsyncClient(timeout=httpx.Timeout(15.0))

    async def redeem(
        self,
        pairing_code: str,
        host_id: str,
        property_id: str,
        vault: CredentialVault,
    ) -> HostIdentity:
        nonce = secrets.token_urlsafe(24)
        request = PairingRedeemRequest(
            pairing_code=pairing_code,
            host_id=host_id,
            property_id=property_id,
            nonce=nonce,
        )
        response = await self.client.post(
            f"{self.base_url}/api/v1/host-agents/pairing/redeem",
            json=request.model_dump(mode="json"),
            headers={"Content-Type": "application/json", "X-Protocol-Version": PROTOCOL_VERSION, "X-Request-Nonce": nonce},
        )
        response.raise_for_status()
        redeemed = PairingRedeemResponse.model_validate(response.json())
        if (
            redeemed.nonce != nonce
            or redeemed.host_id != host_id
            or redeemed.agent_id != AGENT_ID
            or redeemed.property_id != property_id
            or not {"heartbeat", "jobs:claim", "jobs:result", "host:revoke", "ui:read", "ui:operate"}.issubset(redeemed.scope)
            or redeemed.token_expires_at <= datetime.now(UTC)
        ):
            raise ValueError("pairing_response_scope_mismatch")
        identity = HostIdentity(
            host_id=redeemed.host_id,
            agent_id=redeemed.agent_id,
            property_id=redeemed.property_id,
            token=redeemed.host_token,
            token_expires_at=redeemed.token_expires_at,
            scope=redeemed.scope,
        )
        vault.store(identity)
        return identity


def validate_job(job: ClaimedJob, identity: HostIdentity) -> UIAction | None:
    """Validate scope, owner approval, and lease for a v1 allowlisted job."""
    if job.agent_id != identity.agent_id or job.property_id != identity.property_id:
        raise ValueError("job_scope_mismatch")
    if job.action == "ui_snapshot":
        if "ui:read" not in identity.scope:
            raise ValueError("capability_not_allowlisted")
        action = None
    elif job.action == "ui_action" and "ui:operate" in identity.scope:
        action = UIAction.model_validate(
            {**job.payload, "action_id": job.idempotency_key, "owner_approved": True}
        )
    elif job.action == "session_attest":
        if "ui:operate" not in identity.scope or job.payload != {"owner_confirmed": True} or job.automation:
            raise ValueError("capability_not_allowlisted")
        action = None
    elif job.action in OA_ACTIONS:
        required = "ui:read" if job.action in {"oa_list_conversations", "oa_read_conversation"} else "ui:operate"
        if required not in identity.scope:
            raise ValueError("capability_not_allowlisted")
        validate_payload(job.action, job.payload)
        action = None
    else:
        raise ValueError("capability_not_allowlisted")
    if job.automation and (
        job.action not in {"oa_list_conversations", "oa_read_conversation", "oa_reply"}
        or set(job.automation) != {"policy_id", "bot_id", "bot_version"}
        or job.automation["policy_id"] != job.approval_id
    ):
        raise ValueError("automation_scope_mismatch")
    if not job.approval_id or not job.approval_expires_at:
        raise ValueError("owner_approval_required")
    if job.approval_expires_at <= datetime.now(UTC):
        raise ValueError("owner_approval_expired")
    if job.lease_expires_at <= datetime.now(UTC):
        raise ValueError("job_lease_expired")
    approval_body = {
        "agent_id": job.agent_id,
        "property_id": job.property_id,
        "action": job.action,
        "payload": job.payload,
    }
    canonical = json.dumps(approval_body, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    expected_approval_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    if not job.approval_action_sha256 or not secrets.compare_digest(
        job.approval_action_sha256, expected_approval_hash
    ):
        raise ValueError("owner_approval_payload_mismatch")
    return action


class CredentialVault:
    """Store the host token using the operating system credential manager."""

    def __init__(self, service: str, account: str) -> None:
        self.service = service
        self.account = account

    def store(self, identity: HostIdentity) -> None:
        import keyring

        keyring.set_password(self.service, self.account, identity.model_dump_json())

    def load(self) -> HostIdentity | None:
        import keyring

        secret = keyring.get_password(self.service, self.account)
        return HostIdentity.model_validate_json(secret) if secret else None

    def clear(self) -> None:
        import keyring

        try:
            keyring.delete_password(self.service, self.account)
        except keyring.errors.PasswordDeleteError:
            pass


class RelayClient:
    def __init__(
        self,
        base_url: str,
        identity: HostIdentity,
        emulator: AdbEmulator,
        vault: CredentialVault | None = None,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not base_url.startswith("https://"):
            raise ValueError("relay_requires_https")
        self.base_url = base_url.rstrip("/")
        self.identity = identity
        self.emulator = emulator
        self.vault = vault
        self.client = client or httpx.AsyncClient(timeout=httpx.Timeout(45.0))
        self.sequence = identity.last_sequence
        self._stop = asyncio.Event()

    def _headers(self, nonce: str) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.identity.token}",
            "Content-Type": "application/json",
            "X-Host-Id": self.identity.host_id,
            "X-Agent-Id": self.identity.agent_id,
            "X-Property-Id": self.identity.property_id,
            "X-Protocol-Version": PROTOCOL_VERSION,
            "X-Request-Nonce": nonce,
        }

    async def heartbeat_once(self) -> dict[str, Any]:
        self.sequence += 1
        nonce = secrets.token_urlsafe(24)
        payload = HeartbeatRequest(
            host_id=self.identity.host_id,
            property_id=self.identity.property_id,
            sequence=self.sequence,
            nonce=nonce,
            sent_at=datetime.now(UTC),
            status=await asyncio.to_thread(self.emulator.status),
        ).model_dump(mode="json")
        response = await self.client.post(
            f"{self.base_url}/api/v1/host-agents/heartbeat",
            json=payload,
            headers=self._headers(nonce),
        )
        response.raise_for_status()
        receipt = HeartbeatReceipt.model_validate(response.json())
        if receipt.nonce != nonce or receipt.host_id != self.identity.host_id or receipt.sequence != self.sequence or not receipt.accepted:
            raise ValueError("heartbeat_receipt_mismatch")
        self.identity.last_sequence = self.sequence
        if self.vault:
            self.vault.store(self.identity)
        return receipt.model_dump(mode="json")

    async def claim_once(self, wait_seconds: int = 20) -> ClaimedJob | None:
        nonce = secrets.token_urlsafe(24)
        payload = JobClaimRequest(
            host_id=self.identity.host_id,
            property_id=self.identity.property_id,
            nonce=nonce,
            wait_seconds=wait_seconds,
            capabilities=["ui:read", "ui:operate"],
        ).model_dump(mode="json")
        response = await self.client.post(
            f"{self.base_url}/api/v1/host-agents/jobs/claim",
            json=payload,
            headers=self._headers(nonce),
        )
        if response.status_code == 204:
            return None
        response.raise_for_status()
        job = ClaimedJob.model_validate(response.json())
        if job.nonce != nonce or job.agent_id != self.identity.agent_id or job.property_id != self.identity.property_id or job.lease_expires_at <= datetime.now(UTC):
            raise ValueError("claim_response_scope_or_lease_invalid")
        return job

    async def submit_result(self, result: JobResultRequest) -> dict[str, Any]:
        response = await self.client.post(
            f"{self.base_url}/api/v1/host-agents/jobs/{result.job_id}/result",
            json=result.model_dump(mode="json"),
            headers=self._headers(result.nonce),
        )
        response.raise_for_status()
        receipt = ResultReceipt.model_validate(response.json())
        if receipt.nonce != result.nonce or receipt.job_id != result.job_id or receipt.idempotency_key != result.idempotency_key or not receipt.accepted:
            raise ValueError("result_receipt_mismatch")
        return receipt.model_dump(mode="json")

    async def revoke(self) -> bool:
        nonce = secrets.token_urlsafe(24)
        request = RevocationRequest(
            host_id=self.identity.host_id,
            property_id=self.identity.property_id,
            nonce=nonce,
        )
        response = await self.client.post(
            f"{self.base_url}/api/v1/host-agents/disconnect",
            json=request.model_dump(mode="json"),
            headers=self._headers(nonce),
        )
        response.raise_for_status()
        receipt = RevocationReceipt.model_validate(response.json())
        if receipt.nonce != nonce or not receipt.revoked:
            raise ValueError("revocation_receipt_mismatch")
        return True

    async def run_forever(self) -> None:
        async def heartbeats() -> None:
            delay = RETRY_MIN_SECONDS
            while not self._stop.is_set():
                try:
                    await self.heartbeat_once()
                    delay = RETRY_MIN_SECONDS
                    await asyncio.wait_for(self._stop.wait(), timeout=HEARTBEAT_SECONDS)
                except TimeoutError:
                    continue
                except (httpx.HTTPError, ValueError, KeyError, ValidationError):
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, RETRY_MAX_SECONDS)

        async def worker() -> None:
            delay = RETRY_MIN_SECONDS
            while not self._stop.is_set():
                try:
                    job = await self.claim_once()
                    if job:
                        result = await self.execute_job(job)
                        await self.submit_result(result)
                    delay = RETRY_MIN_SECONDS
                except (httpx.HTTPError, ValueError, KeyError, ValidationError):
                    await asyncio.sleep(delay)
                    delay = min(delay * 2, RETRY_MAX_SECONDS)

        tasks = [asyncio.create_task(heartbeats()), asyncio.create_task(worker())]
        try:
            await asyncio.gather(*tasks)
        finally:
            self.stop()
            for task in tasks:
                task.cancel()

    async def execute_job(self, job: ClaimedJob) -> JobResultRequest:
        nonce = secrets.token_urlsafe(24)
        status = "unavailable"
        evidence: list[ResultEvidence] = []
        output: dict[str, Any] | None = None
        error_code = None
        try:
            action = validate_job(job, self.identity)
            if job.action == "session_attest":
                output = await asyncio.to_thread(self.emulator.attest_owner_session, True)
                status = "succeeded"
            elif job.action in OA_ACTIONS:
                remaining = min(job.lease_expires_at, job.approval_expires_at) - datetime.now(UTC)
                guard = (lambda: self.automation_permit(job)) if job.automation else None
                if guard:
                    await asyncio.to_thread(guard)
                output = await asyncio.to_thread(self.emulator.oa.execute, job.action, job.payload, job.idempotency_key, remaining.total_seconds(), guard)
                read = job.action in {"oa_list_conversations", "oa_read_conversation"}
                status = "succeeded" if read or output.get("verified") is True else "partial_success"
                error_code = None if status == "succeeded" else "read_back_verification_required"
                evidence = [ResultEvidence(visible_effect_confirmed=output.get("verified") is True)]
            elif job.action == "ui_snapshot":
                output = await asyncio.to_thread(self.emulator.read_ui)
                evidence = [
                    ResultEvidence(
                        snapshot_id=output["snapshot_id"],
                        screenshot_sha256=output["screenshot_sha256"],
                    )
                ]
                status = "succeeded"
            else:
                assert action is not None
                outcome = await asyncio.to_thread(self.emulator.execute_approved, action)
                status = outcome["status"]
                error_code = None if outcome["verified"] else "read_back_verification_required"
                evidence = [
                    ResultEvidence(
                        snapshot_id=outcome["evidence"][0]["snapshot_id"],
                        screenshot_sha256=outcome["evidence"][0]["screenshot_sha256"],
                        visible_effect_confirmed=outcome["verified"],
                    )
                ]
        except ValueError as exc:
            error_code = str(exc)
            if error_code.startswith("owner_approval"):
                status = "owner_required"
            elif error_code in {"job_lease_expired", "capability_not_allowlisted", "job_scope_mismatch"}:
                status = "blocked"
        except HTTPException as exc:
            code = exc.detail.get("code", "host_action_failed") if isinstance(exc.detail, dict) else "host_action_failed"
            error_code = code
            status = "needs_reauth" if code == "owner_login_not_attested" else "owner_required" if code in {"stale_ui_snapshot", "conversation_ref_expired", "conversation_changed", "recipient_changed", "recipient_ambiguous", "recipient_not_visible", "action_outcome_uncertain"} else "failed"
        except (OSError, RuntimeError, KeyError):
            error_code = "ui_action_failed"
        return JobResultRequest(
            host_id=self.identity.host_id,
            property_id=self.identity.property_id,
            job_id=job.job_id,
            lease_id=job.lease_id,
            idempotency_key=job.idempotency_key,
            nonce=nonce,
            status=status,
            output=output,
            evidence=evidence,
            error_code=error_code,
            completed_at=datetime.now(UTC),
        )

    def stop(self) -> None:
        self._stop.set()

    def automation_permit(self, job: ClaimedJob) -> None:
        """Revalidate the owner's standing policy immediately before a send."""
        nonce = secrets.token_urlsafe(24)
        body = {"protocol_version": PROTOCOL_VERSION, "host_id": self.identity.host_id,
                "agent_id": self.identity.agent_id, "property_id": self.identity.property_id,
                "nonce": nonce, "job_id": job.job_id, "lease_id": job.lease_id}
        try:
            response = httpx.post(f"{self.base_url}/api/v1/host-agents/automation/permit",
                                  headers=self._headers(nonce), json=body, timeout=10)
            response.raise_for_status()
            receipt = response.json()
            if receipt.get("nonce") != nonce or receipt.get("job_id") != job.job_id or receipt.get("allowed") is not True:
                raise ValueError("invalid_permit")
        except (httpx.HTTPError, ValueError) as exc:
            raise HTTPException(status_code=409, detail={"code": "automation_paused"}) from exc

    async def close(self) -> None:
        self.stop()
        await self.client.aclose()
