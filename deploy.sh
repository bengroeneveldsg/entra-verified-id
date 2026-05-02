#!/usr/bin/env bash
# deploy.sh — Interactive deployment wrapper for Entra Verified ID v2
# Usage: ./deploy.sh [--non-interactive] [--destroy] [--stack <name>] [--reveal-bootstrap]
set -euo pipefail

# ── Colours ──────────────────────────────────────────────────────────────────
RED='\033[0;31m'; YELLOW='\033[1;33m'; GREEN='\033[0;32m'
CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'

info()    { echo -e "${CYAN}  ▶ $*${RESET}"; }
success() { echo -e "${GREEN}  ✔ $*${RESET}"; }
warn()    { echo -e "${YELLOW}  ⚠ $*${RESET}"; }
error()   { echo -e "${RED}  ✖ $*${RESET}" >&2; exit 1; }
header()  { echo -e "\n${BOLD}${CYAN}═══ $* ═══${RESET}\n"; }

# ── Flags ────────────────────────────────────────────────────────────────────
NON_INTERACTIVE=false
DESTROY=false
TARGET_STACK=""
REVEAL_BOOTSTRAP=false

for arg in "$@"; do
  case $arg in
    --non-interactive) NON_INTERACTIVE=true ;;
    --destroy)         DESTROY=true ;;
    --reveal-bootstrap)REVEAL_BOOTSTRAP=true ;;
    --stack)           shift; TARGET_STACK="$1" ;;
    --stack=*)         TARGET_STACK="${arg#*=}" ;;
  esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/.deploy.env"

# ── Load cached answers ───────────────────────────────────────────────────────
declare -A SAVED
if [[ -f "$ENV_FILE" ]]; then
  while IFS='=' read -r key val; do
    [[ "$key" =~ ^# ]] && continue
    [[ -z "$key" ]]    && continue
    SAVED["$key"]="$val"
  done < "$ENV_FILE"
fi

save() { SAVED["$1"]="$2"; }

flush_env() {
  {
    echo "# Entra Verified ID v2 deploy configuration — DO NOT COMMIT"
    echo "# Generated $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    for key in "${!SAVED[@]}"; do
      echo "$key=${SAVED[$key]}"
    done
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# ── Prompt helper ─────────────────────────────────────────────────────────────
prompt() {
  local varname="$1" label="$2" default="${3:-}"
  if $NON_INTERACTIVE; then
    [[ -n "${SAVED[$varname]+x}" ]] || error "$label is required (set in .deploy.env as $varname=)"
    eval "$varname=\"${SAVED[$varname]}\""
    return
  fi
  local shown_default=""
  [[ -n "${SAVED[$varname]+x}" ]] && shown_default="${SAVED[$varname]}"
  [[ -n "$default" && -z "$shown_default" ]] && shown_default="$default"
  if [[ -n "$shown_default" ]]; then
    read -rp "  ${label} [${shown_default}]: " input
    input="${input:-$shown_default}"
  else
    read -rp "  ${label}: " input
    while [[ -z "$input" ]]; do
      warn "This field is required."
      read -rp "  ${label}: " input
    done
  fi
  eval "$varname=\"$input\""
  save "$varname" "$input"
}

# ── Selection list ─────────────────────────────────────────────────────────────
select_from_list() {
  # select_from_list <varname> <label> <item1> [<item2> ...]
  local varname="$1" label="$2"
  shift 2
  local items=("$@")
  local i=1
  echo -e "  ${BOLD}${label}${RESET}"
  for item in "${items[@]}"; do
    printf "    %2d. %s\n" "$i" "$item"
    ((i++))
  done
  local choice
  read -rp "  Enter number: " choice
  local idx=$((choice - 1))
  [[ $idx -lt 0 || $idx -ge ${#items[@]} ]] && error "Invalid selection"
  eval "$varname=\"${items[$idx]}\""
}

# ── Multi-select ───────────────────────────────────────────────────────────────
multiselect() {
  local varname="$1" label="$2"
  shift 2
  local items=("$@")
  echo -e "  ${BOLD}${label}${RESET} (enter comma-separated numbers, e.g. 1,3)"
  local i=1
  for item in "${items[@]}"; do
    printf "    %2d. %s\n" "$i" "$item"
    ((i++))
  done
  local choices
  read -rp "  Your choices: " choices
  local result=""
  IFS=',' read -ra selected <<< "$choices"
  for s in "${selected[@]}"; do
    s="${s// /}"
    local idx=$((s - 1))
    [[ $idx -lt 0 || $idx -ge ${#items[@]} ]] && error "Invalid selection: $s"
    result="${result:+$result,}${items[$idx]}"
  done
  eval "$varname=\"$result\""
}

# ── Pre-flight checks ─────────────────────────────────────────────────────────
header "Pre-flight checks"

command -v aws     >/dev/null 2>&1 || error "AWS CLI not found. Install: https://docs.aws.amazon.com/cli/latest/userguide/install-cliv2.html"
command -v node    >/dev/null 2>&1 || error "Node.js not found. Install v20+: https://nodejs.org"
command -v docker  >/dev/null 2>&1 || error "Docker not found. Install Docker Desktop or Docker Engine."
command -v jq      >/dev/null 2>&1 || error "jq not found. Install: sudo apt-get install jq / brew install jq"
command -v npx     >/dev/null 2>&1 || error "npx not found (should come with npm)"

NODE_MAJOR=$(node -e "process.stdout.write(process.versions.node.split('.')[0])")
[[ $NODE_MAJOR -lt 20 ]] && error "Node.js 20+ required (found v$(node --version))"

docker info >/dev/null 2>&1 || error "Docker daemon is not running. Start Docker first."

success "Tools OK (aws, node v$(node --version), docker, jq)"

# ── AWS profile & identity ────────────────────────────────────────────────────
header "AWS credentials"

if ! $NON_INTERACTIVE; then
  AVAILABLE_PROFILES=$(aws configure list-profiles 2>/dev/null | tr '\n' ' ' || echo "default")
  info "Available AWS profiles: $AVAILABLE_PROFILES"
fi

prompt AWS_PROFILE "AWS profile" "${AWS_PROFILE:-default}"
export AWS_PROFILE

IDENTITY=$(aws sts get-caller-identity --output json 2>&1) || error "AWS credentials invalid for profile '$AWS_PROFILE'. Run: aws sso login --profile $AWS_PROFILE"
ACCOUNT=$(echo "$IDENTITY" | jq -r '.Account')
ARN=$(echo "$IDENTITY" | jq -r '.Arn')
info "Account: $ACCOUNT | Identity: $ARN"

if ! $NON_INTERACTIVE; then
  read -rp "  Proceed with this AWS identity? [Y/n]: " confirm
  [[ "${confirm:-Y}" =~ ^[Nn] ]] && { echo "Aborted."; exit 0; }
fi

prompt AWS_REGION "AWS region" "ap-southeast-1"
export CDK_DEFAULT_ACCOUNT="$ACCOUNT"
export CDK_DEFAULT_REGION="$AWS_REGION"

# ── Environment name ──────────────────────────────────────────────────────────
prompt STAGE "Environment name (e.g. v2, dev, staging)" "v2"

# ── VPC selection ─────────────────────────────────────────────────────────────
header "VPC & subnets"

info "Fetching VPCs in $AWS_REGION..."
VPC_JSON=$(aws ec2 describe-vpcs --region "$AWS_REGION" --output json)
VPC_IDS=()
VPC_LABELS=()
while IFS=$'\t' read -r vpc_id cidr name; do
  VPC_IDS+=("$vpc_id")
  VPC_LABELS+=("$vpc_id  CIDR: $cidr  Name: ${name:-<unnamed>}")
done < <(echo "$VPC_JSON" | jq -r '.Vpcs[] | [.VpcId, .CidrBlock, (.Tags // [] | map(select(.Key=="Name")) | .[0].Value // "")] | @tsv')

[[ ${#VPC_IDS[@]} -eq 0 ]] && error "No VPCs found in $AWS_REGION"

if ! $NON_INTERACTIVE; then
  select_from_list SELECTED_LABEL "Choose VPC:" "${VPC_LABELS[@]}"
  VPC_ID=$(echo "$SELECTED_LABEL" | awk '{print $1}')
  save VPC_ID "$VPC_ID"
else
  VPC_ID="${SAVED[VPC_ID]:-}"
  [[ -z "$VPC_ID" ]] && error "VPC_ID required in .deploy.env"
fi

success "VPC: $VPC_ID"

info "Fetching subnets in VPC $VPC_ID..."
SUBNET_JSON=$(aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$VPC_ID" \
  --region "$AWS_REGION" --output json)

PRIVATE_SUBNET_LABELS=()
PUBLIC_SUBNET_LABELS=()
PRIVATE_SUBNET_IDS=()
PUBLIC_SUBNET_IDS=()

while IFS=$'\t' read -r sid az cidr tier name; do
  label="$sid  AZ: $az  CIDR: $cidr  Name: ${name:-<unnamed>}"
  if [[ "$tier" == "private" || "$tier" == "Private" ]]; then
    PRIVATE_SUBNET_IDS+=("$sid")
    PRIVATE_SUBNET_LABELS+=("$label")
  elif [[ "$tier" == "public" || "$tier" == "Public" ]]; then
    PUBLIC_SUBNET_IDS+=("$sid")
    PUBLIC_SUBNET_LABELS+=("$label")
  else
    PRIVATE_SUBNET_IDS+=("$sid")
    PRIVATE_SUBNET_LABELS+=("[untagged] $label")
    PUBLIC_SUBNET_IDS+=("$sid")
    PUBLIC_SUBNET_LABELS+=("[untagged] $label")
  fi
done < <(echo "$SUBNET_JSON" | jq -r '
  .Subnets[] |
  [
    .SubnetId,
    .AvailabilityZone,
    .CidrBlock,
    ((.Tags // []) | map(select(.Key=="Tier")) | .[0].Value // "unknown"),
    ((.Tags // []) | map(select(.Key=="Name")) | .[0].Value // "")
  ] | @tsv
' | sort -k2)

if ! $NON_INTERACTIVE; then
  multiselect PRIVATE_SUBNET_IDS_STR "Private subnets (for admin ALB + Fargate tasks — choose ≥ 2 AZs):" "${PRIVATE_SUBNET_LABELS[@]}"
  # Extract just the subnet IDs from the label strings
  PRIVATE_SUBNET_IDS_STR=$(echo "$PRIVATE_SUBNET_IDS_STR" | tr ',' '\n' | awk '{print $1}' | paste -sd',')
  save PRIVATE_SUBNET_IDS "$PRIVATE_SUBNET_IDS_STR"

  multiselect PUBLIC_SUBNET_IDS_STR "Public subnets (for public ALB — choose ≥ 2 AZs):" "${PUBLIC_SUBNET_LABELS[@]}"
  PUBLIC_SUBNET_IDS_STR=$(echo "$PUBLIC_SUBNET_IDS_STR" | tr ',' '\n' | awk '{print $1}' | paste -sd',')
  save PUBLIC_SUBNET_IDS "$PUBLIC_SUBNET_IDS_STR"
else
  PRIVATE_SUBNET_IDS_STR="${SAVED[PRIVATE_SUBNET_IDS]:-}"
  PUBLIC_SUBNET_IDS_STR="${SAVED[PUBLIC_SUBNET_IDS]:-}"
  [[ -z "$PRIVATE_SUBNET_IDS_STR" ]] && error "PRIVATE_SUBNET_IDS required in .deploy.env"
  [[ -z "$PUBLIC_SUBNET_IDS_STR"  ]] && error "PUBLIC_SUBNET_IDS required in .deploy.env"
fi

success "Private subnets: $PRIVATE_SUBNET_IDS_STR"
success "Public subnets:  $PUBLIC_SUBNET_IDS_STR"

# ── Networking ─────────────────────────────────────────────────────────────────
header "Network access"
prompt VPN_CIDR "VPN CIDR block (who can reach the admin console, e.g. 10.0.0.0/8)" ""
success "VPN CIDR: $VPN_CIDR"

# ── Domains ────────────────────────────────────────────────────────────────────
header "Domain names"
prompt PUBLIC_DOMAIN  "Public-facing domain (e.g. vid-v2.example.com)"          ""
prompt ADMIN_DOMAIN   "Internal admin domain (e.g. admin.internal.example.com)" ""

# ── Route 53 hosted zone ───────────────────────────────────────────────────────
header "Route 53"
info "Fetching hosted zones..."
ZONE_JSON=$(aws route53 list-hosted-zones --output json)
ZONE_IDS=(); ZONE_LABELS=()
while IFS=$'\t' read -r zone_id zone_name; do
  zone_id="${zone_id##*/}"   # strip /hostedzone/ prefix
  ZONE_IDS+=("$zone_id")
  ZONE_LABELS+=("$zone_id  $zone_name")
done < <(echo "$ZONE_JSON" | jq -r '.HostedZones[] | [.Id, .Name] | @tsv')

[[ ${#ZONE_IDS[@]} -eq 0 ]] && error "No hosted zones found in your account. Create one first."

if ! $NON_INTERACTIVE; then
  select_from_list SELECTED_ZONE "Choose the Route 53 zone for DNS validation of ACM certs + DNS records:" "${ZONE_LABELS[@]}"
  HOSTED_ZONE_ID=$(echo "$SELECTED_ZONE" | awk '{print $1}')
  save HOSTED_ZONE_ID "$HOSTED_ZONE_ID"
else
  HOSTED_ZONE_ID="${SAVED[HOSTED_ZONE_ID]:-}"
  [[ -z "$HOSTED_ZONE_ID" ]] && error "HOSTED_ZONE_ID required in .deploy.env"
fi
success "Hosted zone: $HOSTED_ZONE_ID"

# ── ACM certificates ───────────────────────────────────────────────────────────
header "ACM certificates"

request_cert_if_needed() {
  local varname="$1" domain="$2" region="$3" label="$4"
  local existing="${SAVED[$varname]:-}"

  if [[ -n "$existing" ]]; then
    info "$label: using cached ARN $existing"
    eval "$varname=\"$existing\""
    return
  fi

  if ! $NON_INTERACTIVE; then
    read -rp "  $label for $domain in $region — enter existing ARN or press Enter to create new: " cert_arn
    if [[ -z "$cert_arn" ]]; then
      info "Requesting DNS-validated ACM cert for $domain in $region..."
      cert_arn=$(aws acm request-certificate \
        --domain-name "$domain" \
        --validation-method DNS \
        --region "$region" \
        --output text \
        --query 'CertificateArn' 2>&1)
      warn "Certificate requested: $cert_arn"
      warn "Writing DNS validation records to Route 53 zone $HOSTED_ZONE_ID ..."

      sleep 3  # Give ACM a moment to generate the validation options
      VALIDATION=$(aws acm describe-certificate --certificate-arn "$cert_arn" \
        --region "$region" --query 'Certificate.DomainValidationOptions[0].ResourceRecord' \
        --output json 2>/dev/null)
      VAL_NAME=$(echo "$VALIDATION" | jq -r '.Name')
      VAL_VALUE=$(echo "$VALIDATION" | jq -r '.Value')

      if [[ -n "$VAL_NAME" && "$VAL_NAME" != "null" ]]; then
        aws route53 change-resource-record-sets \
          --hosted-zone-id "$HOSTED_ZONE_ID" \
          --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$VAL_NAME\",\"Type\":\"CNAME\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$VAL_VALUE\"}]}}]}" \
          --output text --query 'ChangeInfo.Status' >/dev/null
        info "DNS record written. Waiting for cert to issue (may take 2-5 min)..."
        aws acm wait certificate-validated --certificate-arn "$cert_arn" --region "$region" && \
          success "Certificate issued: $cert_arn" || \
          warn "Cert validation timeout — check AWS console and re-run deploy.sh"
      else
        warn "Could not auto-write validation record — do it manually in ACM console then re-run."
      fi
    fi
    save "$varname" "$cert_arn"
    eval "$varname=\"$cert_arn\""
  else
    error "$label ARN required in .deploy.env as $varname="
  fi
}

request_cert_if_needed CF_CERT_ARN    "$PUBLIC_DOMAIN"  "us-east-1"     "CloudFront cert (us-east-1)"
request_cert_if_needed REGIONAL_CERT  "$PUBLIC_DOMAIN"  "$AWS_REGION"   "Regional cert (public ALB + admin ALB)"
# Admin domain uses the same regional cert if it's a subdomain of the same zone — otherwise request a new one
if [[ "$ADMIN_DOMAIN" != "$PUBLIC_DOMAIN" ]]; then
  request_cert_if_needed REGIONAL_CERT "$ADMIN_DOMAIN" "$AWS_REGION" "Admin regional cert"
fi

success "CloudFront cert:  $CF_CERT_ARN"
success "Regional cert:    $REGIONAL_CERT"

# ── Summary & confirmation ─────────────────────────────────────────────────────
header "Summary"
echo "  Account:         $ACCOUNT"
echo "  Region:          $AWS_REGION"
echo "  Stage:           $STAGE"
echo "  VPC:             $VPC_ID"
echo "  Private subnets: $PRIVATE_SUBNET_IDS_STR"
echo "  Public subnets:  $PUBLIC_SUBNET_IDS_STR"
echo "  VPN CIDR:        $VPN_CIDR"
echo "  Public domain:   $PUBLIC_DOMAIN"
echo "  Admin domain:    $ADMIN_DOMAIN"
echo "  Hosted zone:     $HOSTED_ZONE_ID"
echo "  CF cert:         $CF_CERT_ARN"
echo "  Regional cert:   $REGIONAL_CERT"
echo ""

if $DESTROY; then
  echo -e "${RED}${BOLD}  ⚠ DESTROY MODE — this will delete all v2 stacks and their resources${RESET}"
  read -rp "  Type 'destroy' to confirm: " d_confirm
  [[ "$d_confirm" != "destroy" ]] && { echo "Aborted."; exit 0; }
elif ! $NON_INTERACTIVE; then
  read -rp "  Deploy with these settings? [Y/n]: " deploy_confirm
  [[ "${deploy_confirm:-Y}" =~ ^[Nn] ]] && { echo "Aborted."; exit 0; }
fi

flush_env
success ".deploy.env saved"

# ── Reveal bootstrap secret (read-only, no deploy) ────────────────────────────
if $REVEAL_BOOTSTRAP; then
  info "Fetching bootstrap admin credentials from Secrets Manager..."
  aws secretsmanager get-secret-value \
    --secret-id "EntraVerifiedID/${STAGE}/bootstrap-admin" \
    --region "$AWS_REGION" \
    --query 'SecretString' --output text 2>/dev/null || warn "Secret not found — stack may not be deployed yet."
  exit 0
fi

# ── CDK context file ──────────────────────────────────────────────────────────
CDK_CONTEXT="$SCRIPT_DIR/cdk.context.json"
jq -n \
  --arg vpcId             "$VPC_ID" \
  --arg privateSubnetIds  "$PRIVATE_SUBNET_IDS_STR" \
  --arg publicSubnetIds   "$PUBLIC_SUBNET_IDS_STR" \
  --arg vpnCidr           "$VPN_CIDR" \
  --arg publicDomain      "$PUBLIC_DOMAIN" \
  --arg adminDomain       "$ADMIN_DOMAIN" \
  --arg hostedZoneId      "$HOSTED_ZONE_ID" \
  --arg cfCertArn         "$CF_CERT_ARN" \
  --arg regionalCertArn   "$REGIONAL_CERT" \
  --arg stage             "$STAGE" \
  '{
    vpcId:            $vpcId,
    privateSubnetIds: $privateSubnetIds,
    publicSubnetIds:  $publicSubnetIds,
    vpnCidr:          $vpnCidr,
    publicDomain:     $publicDomain,
    adminDomain:      $adminDomain,
    hostedZoneId:     $hostedZoneId,
    cfCertArn:        $cfCertArn,
    regionalCertArn:  $regionalCertArn,
    stage:            $stage
  }' > "$CDK_CONTEXT"
success "cdk.context.json written"

# ── Install npm deps ──────────────────────────────────────────────────────────
header "Installing dependencies"
cd "$SCRIPT_DIR"
npm install --prefer-offline 2>&1 | tail -3

# ── CDK bootstrap check ───────────────────────────────────────────────────────
header "CDK bootstrap"
BOOTSTRAP_STACK="CDKToolkit"
if ! aws cloudformation describe-stacks --stack-name "$BOOTSTRAP_STACK" \
    --region "$AWS_REGION" --output text --query 'Stacks[0].StackName' 2>/dev/null | grep -q CDKToolkit; then
  info "Bootstrapping CDK in account $ACCOUNT / $AWS_REGION..."
  npx cdk bootstrap "aws://${ACCOUNT}/${AWS_REGION}" 2>&1
fi
success "CDK bootstrapped"

# ── Deploy ────────────────────────────────────────────────────────────────────
header "Deploying stacks"

if $DESTROY; then
  DESTROY_TARGET="${TARGET_STACK:-"EntraVid-Admin-${STAGE} EntraVid-PublicFrontend-${STAGE} EntraVid-MainApp-${STAGE} EntraVid-Layers-${STAGE} EntraVid-Data-${STAGE}"}"
  # shellcheck disable=SC2086
  npx cdk destroy $DESTROY_TARGET --force 2>&1
  success "Stacks destroyed"
  exit 0
fi

if [[ -n "$TARGET_STACK" ]]; then
  DEPLOY_TARGETS="EntraVid-${TARGET_STACK}-${STAGE}"
else
  DEPLOY_TARGETS="EntraVid-Data-${STAGE} EntraVid-Layers-${STAGE} EntraVid-MainApp-${STAGE} EntraVid-PublicFrontend-${STAGE} EntraVid-Admin-${STAGE}"
fi

# shellcheck disable=SC2086
npx cdk deploy $DEPLOY_TARGETS \
  --require-approval never \
  --outputs-file "$SCRIPT_DIR/cdk-outputs.json" \
  2>&1

# ── Post-deploy summary ───────────────────────────────────────────────────────
header "Deployment complete"

if [[ -f "$SCRIPT_DIR/cdk-outputs.json" ]]; then
  PUBLIC_URL=$(jq -r ".[\"EntraVid-PublicFrontend-${STAGE}\"].PublicUrl // \"(not yet deployed)\"" "$SCRIPT_DIR/cdk-outputs.json")
  ADMIN_URL=$(jq  -r ".[\"EntraVid-Admin-${STAGE}\"].AdminUrl         // \"(not yet deployed)\"" "$SCRIPT_DIR/cdk-outputs.json")
  API_URL=$(jq    -r ".[\"EntraVid-MainApp-${STAGE}\"].ApiUrl          // \"(not yet deployed)\"" "$SCRIPT_DIR/cdk-outputs.json")
  BOOTSTRAP_ARN=$(jq -r ".[\"EntraVid-Data-${STAGE}\"].BootstrapSecretArn // \"\"" "$SCRIPT_DIR/cdk-outputs.json")

  success "Public URL:   $PUBLIC_URL"
  success "API URL:      $API_URL"
  success "Admin URL:    $ADMIN_URL (accessible from VPN: $VPN_CIDR)"
  echo ""
  echo -e "${BOLD}  Next step — initial admin login:${RESET}"
  echo "  1. Connect to your VPN ($VPN_CIDR)"
  echo "  2. Open $ADMIN_URL in your browser"
  echo "  3. Use these one-time bootstrap credentials:"
  echo ""
  if [[ -n "$BOOTSTRAP_ARN" ]]; then
    BOOTSTRAP_SECRET=$(aws secretsmanager get-secret-value \
      --secret-id "$BOOTSTRAP_ARN" \
      --region "$AWS_REGION" \
      --query 'SecretString' --output text 2>/dev/null || echo '{"error":"secret not found"}')
    BOOTSTRAP_USER=$(echo "$BOOTSTRAP_SECRET" | jq -r '.username // "admin"')
    BOOTSTRAP_PASS=$(echo "$BOOTSTRAP_SECRET" | jq -r '.password // "(run ./deploy.sh --reveal-bootstrap)"')
    echo "     Username: $BOOTSTRAP_USER"
    echo "     Password: $BOOTSTRAP_PASS"
    echo ""
    echo -e "${YELLOW}  ⚠ Save these credentials — they appear once here and are deleted by the wizard.${RESET}"
    echo "     To display them again: ./deploy.sh --reveal-bootstrap"
  fi
  echo ""
  echo "  4. Complete the onboarding wizard to configure your Entra tenant."
  echo "  5. When done, run a full smoke test:"
  echo "     curl -sf $API_URL/api/login/start | jq"
fi

echo ""
success "Done. See cdk-outputs.json for all stack outputs."
