#!/usr/bin/env bash
# destroy.sh — Permanently tear down an Entra Verified ID v2 deployment
#
# Usage:
#   ./destroy.sh                    interactive (reads .deploy.env if present)
#   ./destroy.sh --non-interactive  fully unattended — reads all values from .deploy.env
#
# WARNING: This script permanently deletes ALL resources for the given stage,
# including data that cannot be recovered. Run only when you are certain.
set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}  ▶ $*${RESET}"; }
success() { echo -e "${GREEN}  ✔ $*${RESET}"; }
warn()    { echo -e "${YELLOW}  ⚠ $*${RESET}"; }
error()   { echo -e "${RED}  ✖ $*${RESET}" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}═══ $* ═══${RESET}\n"; }

NON_INTERACTIVE=false
for arg in "$@"; do
  case $arg in
    --non-interactive) NON_INTERACTIVE=true ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.deploy.env"

# ── Load .deploy.env ─────────────────────────────────────────────────────────
_load_env() {
  [[ -f "$ENV_FILE" ]] || return 0
  while IFS='=' read -r key val; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    val="${val%%#*}"
    val="${val%"${val##*[![:space:]]}"}"
    printf -v "$key" '%s' "$val"
  done < "$ENV_FILE"
}
_load_env

# ── Resolve settings ─────────────────────────────────────────────────────────
AWS_PROFILE="${AWS_PROFILE:-}"
ACCOUNT="${CDK_DEFAULT_ACCOUNT:-}"
AWS_REGION="${CDK_DEFAULT_REGION:-ap-southeast-1}"
STAGE="${STAGE:-}"

if ! $NON_INTERACTIVE; then
  echo ""
  echo -e "${RED}${BOLD}╔══════════════════════════════════════════════════════════════════╗${RESET}"
  echo -e "${RED}${BOLD}║          ENTRA VERIFIED ID — PERMANENT TEARDOWN                  ║${RESET}"
  echo -e "${RED}${BOLD}╚══════════════════════════════════════════════════════════════════╝${RESET}"
  echo ""
  echo -e "  ${BOLD}This script will permanently and irreversibly delete:${RESET}"
  echo ""
  echo -e "    ${RED}✖${RESET}  All 5 CloudFormation stacks (Admin, Frontend, MainApp, Layers, Data)"
  echo -e "    ${RED}✖${RESET}  All DynamoDB tables — including all sessions, SAML apps, audit logs,"
  echo -e "         signing keys, and system configuration"
  echo -e "    ${RED}✖${RESET}  All S3 bucket contents — hosting files, well-known documents"
  echo -e "    ${RED}✖${RESET}  All Secrets Manager secrets — client secrets, signing keys"
  echo -e "    ${RED}✖${RESET}  All Lambda functions, API Gateway, CloudFront distribution"
  echo -e "    ${RED}✖${RESET}  All ECS services, task definitions, CloudWatch log groups"
  echo ""
  echo -e "  ${YELLOW}${BOLD}This action cannot be undone. There is no recovery.${RESET}"
  echo ""

  [[ -z "$AWS_PROFILE" ]] && read -rp "  AWS profile: " AWS_PROFILE
  [[ -z "$ACCOUNT"     ]] && read -rp "  AWS account ID: " ACCOUNT
  [[ -z "$AWS_REGION"  ]] && read -rp "  AWS region [ap-southeast-1]: " input_region && \
    AWS_REGION="${input_region:-ap-southeast-1}"
  [[ -z "$STAGE"       ]] && read -rp "  Stage name (e.g. v2, demo): " STAGE
else
  [[ -z "$AWS_PROFILE" ]] && error "AWS_PROFILE required in .deploy.env"
  [[ -z "$ACCOUNT"     ]] && error "CDK_DEFAULT_ACCOUNT required in .deploy.env"
  [[ -z "$STAGE"       ]] && error "STAGE required in .deploy.env"
fi

export AWS_PROFILE
export CDK_DEFAULT_ACCOUNT="$ACCOUNT"
export CDK_DEFAULT_REGION="$AWS_REGION"
export AWS_REGION

# Verify credentials
info "Verifying AWS credentials..."
CALLER=$(aws sts get-caller-identity --query '[Account,Arn]' --output text 2>&1) \
  || error "AWS credentials not valid. Run 'aws sso login --profile $AWS_PROFILE' first."
CALLER_ACCOUNT=$(echo "$CALLER" | awk '{print $1}')
CALLER_ARN=$(echo "$CALLER" | awk '{print $2}')
[[ "$CALLER_ACCOUNT" != "$ACCOUNT" ]] && \
  error "Credential account $CALLER_ACCOUNT does not match expected $ACCOUNT"
success "Authenticated as: $CALLER_ARN"

# ── Show what will be destroyed ───────────────────────────────────────────────
header "Teardown target"
echo -e "  ${BOLD}Account:${RESET}  $ACCOUNT"
echo -e "  ${BOLD}Region:${RESET}   $AWS_REGION"
echo -e "  ${BOLD}Stage:${RESET}    ${RED}${BOLD}$STAGE${RESET}"
echo ""

# List stacks that actually exist
STACKS_FOUND=()
for stack in "EntraVid-Admin-${STAGE}" "EntraVid-PublicFrontend-${STAGE}" \
             "EntraVid-MainApp-${STAGE}" "EntraVid-Layers-${STAGE}" "EntraVid-Data-${STAGE}"; do
  status=$(aws cloudformation describe-stacks --stack-name "$stack" \
    --region "$AWS_REGION" --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo "NOT_FOUND")
  if [[ "$status" != "NOT_FOUND" ]]; then
    echo -e "    ${RED}✖${RESET}  $stack  ${YELLOW}($status)${RESET}"
    STACKS_FOUND+=("$stack")
  else
    echo -e "    ${CYAN}–${RESET}  $stack  (not deployed)"
  fi
done
echo ""

# List retained resources
echo -e "  ${BOLD}Retained resources that will also be permanently deleted:${RESET}"
echo ""

# S3 buckets
for bucket in "entra-vid-hosting-${ACCOUNT}-${STAGE}" "entra-vid-well-known-${ACCOUNT}-${STAGE}"; do
  if aws s3api head-bucket --bucket "$bucket" 2>/dev/null; then
    obj_count=$(aws s3 ls "s3://$bucket" --recursive 2>/dev/null | wc -l || echo "?")
    echo -e "    ${RED}✖${RESET}  s3://$bucket  (${obj_count} objects)"
  fi
done

# DynamoDB tables
for table in "EntraVerifiedID-${STAGE}" "EntraVerifiedIDSystemConfig-${STAGE}" \
             "EntraVerifiedIDAdminUsers-${STAGE}" "EntraVerifiedIDAuditLog-${STAGE}" \
             "VerifiedIDSamlApps-${STAGE}"; do
  if aws dynamodb describe-table --table-name "$table" --region "$AWS_REGION" \
      --query 'Table.TableName' --output text 2>/dev/null | grep -q "$table"; then
    item_count=$(aws dynamodb describe-table --table-name "$table" --region "$AWS_REGION" \
      --query 'Table.ItemCount' --output text 2>/dev/null || echo "?")
    echo -e "    ${RED}✖${RESET}  DynamoDB: $table  (${item_count} items)"
  fi
done

# Secrets
for secret_prefix in "EntraVerifiedID/${STAGE}/"; do
  while IFS= read -r s; do
    [[ -z "$s" ]] && continue
    echo -e "    ${RED}✖${RESET}  Secret: $s"
  done < <(aws secretsmanager list-secrets --region "$AWS_REGION" \
    --include-planned-deletion \
    --query "SecretList[?starts_with(Name,'${secret_prefix}')].Name" \
    --output text 2>/dev/null | tr '\t' '\n')
done

echo ""

# ── Double confirmation ───────────────────────────────────────────────────────
if ! $NON_INTERACTIVE; then
  echo -e "  ${RED}${BOLD}To proceed, you must confirm twice.${RESET}"
  echo ""
  read -rp "  Type the stage name to confirm (${BOLD}${STAGE}${RESET}): " confirm1
  [[ "$confirm1" != "$STAGE" ]] && { echo ""; error "Stage name did not match. Aborted."; }

  echo ""
  echo -e "  ${RED}${BOLD}Final warning: all data listed above will be permanently deleted.${RESET}"
  echo ""
  read -rp "  Type 'permanently destroy' to proceed: " confirm2
  [[ "$confirm2" != "permanently destroy" ]] && { echo ""; error "Confirmation phrase did not match. Aborted."; }
  echo ""
fi

# ── Install npm dependencies ──────────────────────────────────────────────────
header "Preparing"
cd "$SCRIPT_DIR"
if [[ "${AWS_EXECUTION_ENV:-}" == "CloudShell" ]]; then
  export npm_config_cache=/tmp/npm-cache
fi
npm install --prefer-offline 2>&1 | tail -5
success "Dependencies ready"

# ── Step 1: CDK destroy ───────────────────────────────────────────────────────
header "Step 1/4 — Destroying CloudFormation stacks"
if [[ ${#STACKS_FOUND[@]} -eq 0 ]]; then
  warn "No stacks found — skipping CDK destroy"
else
  # Write minimal cdk.context.json so CDK can synth without prompting for VPC lookups
  # (destroy does not need VPC data but CDK still reads context at synth time)
  EXISTING_CONTEXT="$SCRIPT_DIR/cdk.context.json"
  if [[ ! -f "$EXISTING_CONTEXT" ]]; then
    echo '{}' > "$EXISTING_CONTEXT"
  fi

  # shellcheck disable=SC2068
  npx cdk destroy ${STACKS_FOUND[@]} --force 2>&1 || warn "CDK destroy reported errors — continuing cleanup"
  success "CloudFormation stacks destroyed"
fi

# ── Step 2: Empty and delete S3 buckets ──────────────────────────────────────
header "Step 2/4 — Removing S3 buckets"
for bucket in "entra-vid-hosting-${ACCOUNT}-${STAGE}" "entra-vid-well-known-${ACCOUNT}-${STAGE}"; do
  if aws s3api head-bucket --bucket "$bucket" 2>/dev/null; then
    info "Emptying $bucket (including all versions)..."
    # Delete all object versions and delete markers
    aws s3api list-object-versions --bucket "$bucket" \
      --query '{Objects: Versions[].{Key:Key,VersionId:VersionId}}' \
      --output json 2>/dev/null | \
      python3 -c "
import json,sys,subprocess
data=json.load(sys.stdin)
objs=data.get('Objects') or []
if not objs: sys.exit(0)
batch={'Objects':objs,'Quiet':True}
import boto3
s3=boto3.client('s3')
s3.delete_objects(Bucket='$bucket',Delete=batch)
print(f'  Deleted {len(objs)} versions')
" 2>/dev/null || true
    # Delete remaining objects (unversioned) and delete markers
    aws s3 rm "s3://$bucket" --recursive 2>/dev/null || true
    aws s3api delete-bucket --bucket "$bucket" --region "$AWS_REGION" 2>/dev/null \
      && success "Deleted s3://$bucket" \
      || warn "Could not delete s3://$bucket (may already be gone)"
  else
    info "Bucket $bucket not found — skipping"
  fi
done

# ── Step 3: Force-delete Secrets Manager secrets ─────────────────────────────
header "Step 3/4 — Removing Secrets Manager secrets"
while IFS= read -r secret; do
  [[ -z "$secret" ]] && continue
  aws secretsmanager delete-secret \
    --secret-id "$secret" \
    --force-delete-without-recovery \
    --region "$AWS_REGION" 2>/dev/null \
    && success "Deleted secret: $secret" \
    || warn "Could not delete $secret (may already be gone)"
done < <(aws secretsmanager list-secrets --region "$AWS_REGION" \
  --include-planned-deletion \
  --query "SecretList[?starts_with(Name,'EntraVerifiedID/${STAGE}/')].Name" \
  --output text 2>/dev/null | tr '\t' '\n')

# ── Step 4: Delete DynamoDB tables ────────────────────────────────────────────
header "Step 4/4 — Removing DynamoDB tables"
for table in "EntraVerifiedID-${STAGE}" "EntraVerifiedIDSystemConfig-${STAGE}" \
             "EntraVerifiedIDAdminUsers-${STAGE}" "EntraVerifiedIDAuditLog-${STAGE}" \
             "VerifiedIDSamlApps-${STAGE}"; do
  if aws dynamodb describe-table --table-name "$table" \
      --region "$AWS_REGION" --output text 2>/dev/null | grep -q ACTIVE; then
    aws dynamodb delete-table --table-name "$table" --region "$AWS_REGION" 2>/dev/null \
      && success "Deleted table: $table" \
      || warn "Could not delete $table (may already be gone)"
  else
    info "Table $table not found — skipping"
  fi
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo ""
echo -e "${GREEN}${BOLD}╔══════════════════════════════════════════════════════════════════╗${RESET}"
echo -e "${GREEN}${BOLD}║                  TEARDOWN COMPLETE                               ║${RESET}"
echo -e "${GREEN}${BOLD}╚══════════════════════════════════════════════════════════════════╝${RESET}"
echo ""
echo -e "  All AWS resources for stage ${BOLD}${STAGE}${RESET} have been permanently removed."
echo ""
echo -e "  ${YELLOW}${BOLD}Manual cleanup still required:${RESET}"
echo -e "    ${YELLOW}•${RESET}  DNS — remove the CNAME record for your domain pointing to CloudFront"
echo -e "    ${YELLOW}•${RESET}  ACM certificates — delete via the AWS Certificate Manager console"
echo -e "         (us-east-1 for the CloudFront cert, ${AWS_REGION} for the ALB cert)"
echo -e "    ${YELLOW}•${RESET}  Entra app registration — remove the client secret used for this"
echo -e "         deployment from your app registration in the Azure portal"
echo -e "    ${YELLOW}•${RESET}  .deploy.env — remove or archive this file from your local machine"
echo ""
