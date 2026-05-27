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

# ── Load cached answers (bash 3.2-compatible — no associative arrays) ──────────
# Keys are tracked in a plain array; values stored as DEPLOY_SAVED_<KEY> vars.
_SAVED_KEYS=()

_saved_set() {
  local key="$1" val="$2"
  printf -v "DEPLOY_SAVED_${key}" '%s' "$val"
  local k; for k in "${_SAVED_KEYS[@]:-}"; do [[ "$k" == "$key" ]] && return; done
  _SAVED_KEYS+=("$key")
}

_saved_get() { local ref="DEPLOY_SAVED_${1}"; echo "${!ref:-}"; }

_saved_has() {
  local key="$1" k
  for k in "${_SAVED_KEYS[@]:-}"; do [[ "$k" == "$key" ]] && return 0; done
  return 1
}

if [[ -f "$ENV_FILE" ]]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^# ]] && continue
    [[ -z "$line" ]]    && continue
    local_key="${line%%=*}"
    local_val="${line#*=}"
    [[ -z "$local_key" ]] && continue
    _saved_set "$local_key" "$local_val"
  done < "$ENV_FILE"
fi

save() { _saved_set "$1" "$2"; }

flush_env() {
  {
    echo "# Entra Verified ID v2 deploy configuration — DO NOT COMMIT"
    echo "# Generated $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    local k
    for k in "${_SAVED_KEYS[@]:-}"; do
      echo "${k}=$(_saved_get "$k")"
    done
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

# ── Prompt helper ─────────────────────────────────────────────────────────────
prompt() {
  local varname="$1" label="$2" default="${3:-}"
  if $NON_INTERACTIVE; then
    _saved_has "$varname" || error "$label is required (set in .deploy.env as $varname=)"
    printf -v "$varname" '%s' "$(_saved_get "$varname")"
    return
  fi
  local shown_default=""
  _saved_has "$varname" && shown_default="$(_saved_get "$varname")"
  [[ -n "$default" && -z "$shown_default" ]] && shown_default="$default"
  local input
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
  printf -v "$varname" '%s' "$input"
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

# CloudShell provides ambient credentials via env vars — no profile needed
if [[ "${AWS_EXECUTION_ENV:-}" == "CloudShell" ]]; then
  info "CloudShell detected — using ambient credentials (no profile needed)"
  unset AWS_PROFILE
else
  if ! $NON_INTERACTIVE; then
    AVAILABLE_PROFILES=$(aws configure list-profiles 2>/dev/null | tr '\n' ' ' || echo "")
    [[ -n "$AVAILABLE_PROFILES" ]] && info "Available AWS profiles: $AVAILABLE_PROFILES"
  fi
  prompt AWS_PROFILE "AWS profile" "${AWS_PROFILE:-default}"
  export AWS_PROFILE
fi

IDENTITY=$(aws sts get-caller-identity --output json 2>&1) || error "AWS credentials invalid${AWS_PROFILE:+ for profile '$AWS_PROFILE'}. Run: aws sso login${AWS_PROFILE:+ --profile $AWS_PROFILE}"
ACCOUNT=$(echo "$IDENTITY" | jq -r '.Account')
ARN=$(echo "$IDENTITY" | jq -r '.Arn')
info "Account: $ACCOUNT | Identity: $ARN"

if ! $NON_INTERACTIVE; then
  read -rp "  Proceed with this AWS identity? [Y/n]: " confirm
  [[ "${confirm:-Y}" =~ ^[Nn] ]] && { echo "Aborted."; exit 0; }
fi

prompt AWS_REGION "AWS region" ""
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

# ── Frontend (public) VPC ─────────────────────────────────────────────────────
echo -e "\n  ${BOLD}Public Frontend VPC${RESET} — CloudFront VPC Origin + Fargate"
warn "This VPC must have an Internet Gateway attached (required by CloudFront VPC Origins)."

if ! $NON_INTERACTIVE; then
  select_from_list SELECTED_LABEL "Choose frontend VPC:" "${VPC_LABELS[@]}"
  PUBLIC_VPC_ID=$(echo "$SELECTED_LABEL" | grep -oE 'vpc-[a-z0-9]+' | head -1)
  save PUBLIC_VPC_ID "$PUBLIC_VPC_ID"
else
  PUBLIC_VPC_ID="$(_saved_get PUBLIC_VPC_ID)"
  [[ -z "$PUBLIC_VPC_ID" ]] && error "PUBLIC_VPC_ID required in .deploy.env"
fi
success "Frontend VPC: $PUBLIC_VPC_ID"

info "Fetching subnets in VPC $PUBLIC_VPC_ID..."
SUBNET_JSON=$(aws ec2 describe-subnets \
  --filters "Name=vpc-id,Values=$PUBLIC_VPC_ID" \
  --region "$AWS_REGION" --output json)

PUBLIC_SUBNET_LABELS=()
while IFS=$'\t' read -r sid az cidr tier name; do
  label="$sid  AZ: $az  CIDR: $cidr  Name: ${name:-<unnamed>}"
  [[ "$tier" != "private" && "$tier" != "Private" && "$tier" != "public" && "$tier" != "Public" ]] && label="[untagged] $label"
  PUBLIC_SUBNET_LABELS+=("$label")
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
  multiselect PUBLIC_SUBNET_IDS_STR "Frontend subnets (ALB + Fargate — choose ≥ 2 AZs):" "${PUBLIC_SUBNET_LABELS[@]}"
  PUBLIC_SUBNET_IDS_STR=$(echo "$PUBLIC_SUBNET_IDS_STR" | tr ',' '\n' | grep -oE 'subnet-[a-z0-9]+' | tr '\n' ',' | sed 's/,$//')
  save PUBLIC_SUBNET_IDS "$PUBLIC_SUBNET_IDS_STR"
else
  PUBLIC_SUBNET_IDS_STR="$(_saved_get PUBLIC_SUBNET_IDS)"
  [[ -z "$PUBLIC_SUBNET_IDS_STR" ]] && error "PUBLIC_SUBNET_IDS required in .deploy.env"
fi
success "Frontend subnets: $PUBLIC_SUBNET_IDS_STR"

# ── Admin console VPC ─────────────────────────────────────────────────────────
echo -e "\n  ${BOLD}Admin Console VPC${RESET} — internal ALB + Fargate (VPN access only)"
info "This VPC needs outbound internet access (NAT, Cloud WAN, etc.) for ECR image pulls."

SAME_ADMIN_VPC=false
if ! $NON_INTERACTIVE; then
  read -rp "  Use the same VPC for admin as frontend? [y/N]: " same_vpc_input
  if [[ "${same_vpc_input:-N}" =~ ^[Yy] ]]; then
    SAME_ADMIN_VPC=true
    VPC_ID="$PUBLIC_VPC_ID"
    save VPC_ID "$VPC_ID"
    PRIVATE_SUBNET_IDS_STR="$PUBLIC_SUBNET_IDS_STR"
    save PRIVATE_SUBNET_IDS "$PRIVATE_SUBNET_IDS_STR"
    info "Admin will share VPC and subnets with the frontend."
  fi
fi

if ! $SAME_ADMIN_VPC; then
  if ! $NON_INTERACTIVE; then
    select_from_list SELECTED_LABEL "Choose admin VPC:" "${VPC_LABELS[@]}"
    VPC_ID=$(echo "$SELECTED_LABEL" | grep -oE 'vpc-[a-z0-9]+' | head -1)
    save VPC_ID "$VPC_ID"
  else
    VPC_ID="$(_saved_get VPC_ID)"
    [[ -z "$VPC_ID" ]] && error "VPC_ID required in .deploy.env"
  fi

  info "Fetching subnets in VPC $VPC_ID..."
  SUBNET_JSON=$(aws ec2 describe-subnets \
    --filters "Name=vpc-id,Values=$VPC_ID" \
    --region "$AWS_REGION" --output json)

  PRIVATE_SUBNET_LABELS=()
  while IFS=$'\t' read -r sid az cidr tier name; do
    label="$sid  AZ: $az  CIDR: $cidr  Name: ${name:-<unnamed>}"
    [[ "$tier" != "private" && "$tier" != "Private" && "$tier" != "public" && "$tier" != "Public" ]] && label="[untagged] $label"
    PRIVATE_SUBNET_LABELS+=("$label")
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
    multiselect PRIVATE_SUBNET_IDS_STR "Admin subnets (ALB + Fargate — choose ≥ 2 AZs):" "${PRIVATE_SUBNET_LABELS[@]}"
    PRIVATE_SUBNET_IDS_STR=$(echo "$PRIVATE_SUBNET_IDS_STR" | tr ',' '\n' | grep -oE 'subnet-[a-z0-9]+' | tr '\n' ',' | sed 's/,$//')
    save PRIVATE_SUBNET_IDS "$PRIVATE_SUBNET_IDS_STR"
  else
    PRIVATE_SUBNET_IDS_STR="$(_saved_get PRIVATE_SUBNET_IDS)"
    [[ -z "$PRIVATE_SUBNET_IDS_STR" ]] && error "PRIVATE_SUBNET_IDS required in .deploy.env"
  fi
fi

success "Admin VPC:     $VPC_ID"
success "Admin subnets: $PRIVATE_SUBNET_IDS_STR"

# ── Networking ─────────────────────────────────────────────────────────────────
header "Network access"
prompt VPN_CIDR "Internal network CIDR (who can reach the admin console, e.g. 10.0.0.0/8)" ""
success "Internal CIDR: $VPN_CIDR"

# ── CloudFront VPC Origins prefix list ────────────────────────────────────────
header "CloudFront VPC Origins"
info "Looking up CloudFront VPC Origins prefix list in $AWS_REGION..."
CF_PREFIX_LIST_ID=$(aws ec2 describe-managed-prefix-lists \
  --region "$AWS_REGION" \
  --filters "Name=prefix-list-name,Values=com.amazonaws.global.cloudfront.origin-facing" \
  --query 'PrefixLists[0].PrefixListId' --output text 2>/dev/null || echo "")
if [[ -n "$CF_PREFIX_LIST_ID" && "$CF_PREFIX_LIST_ID" != "None" ]]; then
  save CF_PREFIX_LIST_ID "$CF_PREFIX_LIST_ID"
  success "CloudFront prefix list: $CF_PREFIX_LIST_ID"
else
  warn "Could not resolve CloudFront prefix list — ALB will allow all inbound on port 80 (safe: internal ALB)"
  CF_PREFIX_LIST_ID=""
fi

# ── Domains ────────────────────────────────────────────────────────────────────
header "Domain names"
prompt PUBLIC_DOMAIN  "Public-facing domain (e.g. vid.example.com)" ""
if ! $NON_INTERACTIVE; then
  read -rp "  Internal admin domain (e.g. admin.example.com) [Enter to skip — HTTP + ALB DNS only]: " ADMIN_DOMAIN
  ADMIN_DOMAIN="${ADMIN_DOMAIN:-}"
  save ADMIN_DOMAIN "$ADMIN_DOMAIN"
  if [[ -z "$ADMIN_DOMAIN" ]]; then
    info "No admin domain — admin console will be HTTP only, reachable via ALB DNS name from VPN. You can CNAME a domain to it later."
  fi
else
  ADMIN_DOMAIN="$(_saved_get ADMIN_DOMAIN)"
fi

# ── Route 53 hosted zone (optional) ──────────────────────────────────────────
header "Route 53 (optional)"
info "Fetching hosted zones in this account..."
ZONE_JSON=$(aws route53 list-hosted-zones --output json 2>/dev/null || echo '{"HostedZones":[]}')
ZONE_IDS=(); ZONE_LABELS=()
while IFS=$'\t' read -r zone_id zone_name; do
  zone_id="${zone_id##*/}"   # strip /hostedzone/ prefix
  ZONE_IDS+=("$zone_id")
  ZONE_LABELS+=("$zone_id  $zone_name")
done < <(echo "$ZONE_JSON" | jq -r '.HostedZones[] | [.Id, .Name] | @tsv')

HOSTED_ZONE_ID="$(_saved_get HOSTED_ZONE_ID)"

if ! $NON_INTERACTIVE; then
  if [[ ${#ZONE_IDS[@]} -eq 0 ]]; then
    warn "No hosted zones found in this account — DNS records must be added manually after deploy."
    HOSTED_ZONE_ID=""
    save HOSTED_ZONE_ID ""
  else
    read -rp "  Use Route 53 in this account for automatic DNS + cert validation? [Y/n]: " use_r53
    if [[ "${use_r53:-Y}" =~ ^[Yy] ]]; then
      select_from_list SELECTED_ZONE "Choose Route 53 hosted zone:" "${ZONE_LABELS[@]}"
      HOSTED_ZONE_ID=$(echo "$SELECTED_ZONE" | awk '{print $1}')
      save HOSTED_ZONE_ID "$HOSTED_ZONE_ID"
    else
      HOSTED_ZONE_ID=""
      save HOSTED_ZONE_ID ""
      info "DNS records will need to be created manually — values shown after cert requests and after deploy."
    fi
  fi
fi

if [[ -n "$HOSTED_ZONE_ID" ]]; then
  success "Hosted zone: $HOSTED_ZONE_ID"
else
  warn "No hosted zone — proceeding without automatic DNS management."
fi

# ── ACM certificates ───────────────────────────────────────────────────────────
header "ACM certificates"

request_cert_if_needed() {
  local varname="$1" domain="$2" region="$3" label="$4"
  local existing; existing="$(_saved_get "$varname")"

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
      info "Certificate ARN: $cert_arn"

      sleep 3  # Give ACM a moment to generate the validation options
      VALIDATION=$(aws acm describe-certificate --certificate-arn "$cert_arn" \
        --region "$region" --query 'Certificate.DomainValidationOptions[0].ResourceRecord' \
        --output json 2>/dev/null)
      VAL_NAME=$(echo "$VALIDATION" | jq -r '.Name')
      VAL_VALUE=$(echo "$VALIDATION" | jq -r '.Value')

      if [[ -n "$VAL_NAME" && "$VAL_NAME" != "null" ]]; then
        if [[ -n "$HOSTED_ZONE_ID" ]]; then
          warn "Writing DNS validation record to Route 53 zone $HOSTED_ZONE_ID ..."
          aws route53 change-resource-record-sets \
            --hosted-zone-id "$HOSTED_ZONE_ID" \
            --change-batch "{\"Changes\":[{\"Action\":\"UPSERT\",\"ResourceRecordSet\":{\"Name\":\"$VAL_NAME\",\"Type\":\"CNAME\",\"TTL\":300,\"ResourceRecords\":[{\"Value\":\"$VAL_VALUE\"}]}}]}" \
            --output text --query 'ChangeInfo.Status' >/dev/null
          info "DNS record written. Waiting for cert to issue (may take 2-5 min)..."
          aws acm wait certificate-validated --certificate-arn "$cert_arn" --region "$region" && \
            success "Certificate issued: $cert_arn" || \
            warn "Cert validation timeout — check AWS console and re-run deploy.sh"
        else
          echo ""
          echo -e "${BOLD}  ── Manual DNS validation required ──────────────────────────────${RESET}"
          echo "  Add this CNAME record to your DNS provider, then press Enter:"
          echo ""
          echo "    Name:  $VAL_NAME"
          echo "    Type:  CNAME"
          echo "    Value: $VAL_VALUE"
          echo ""
          read -rp "  Press Enter once the CNAME record is live (Ctrl+C to pause and re-run later): "
          info "Waiting for ACM to validate $domain (may take 2-5 min after DNS propagates)..."
          aws acm wait certificate-validated --certificate-arn "$cert_arn" --region "$region" && \
            success "Certificate issued: $cert_arn" || \
            warn "Cert validation timeout — DNS may still be propagating. Re-run deploy.sh to retry."
        fi
      else
        warn "Could not retrieve validation record yet — check ACM console for $cert_arn and add the CNAME manually."
      fi
    fi
    save "$varname" "$cert_arn"
    eval "$varname=\"$cert_arn\""
  else
    error "$label ARN required in .deploy.env as $varname="
  fi
}

request_cert_if_needed CF_CERT_ARN "$PUBLIC_DOMAIN" "us-east-1" "CloudFront cert (us-east-1)"

# Regional cert only needed when there is a hosted zone (API CNAME record) or an admin domain with HTTPS
REGIONAL_CERT=""
ADMIN_CERT_ARN=""
if [[ -n "$ADMIN_DOMAIN" ]]; then
  if [[ "$ADMIN_DOMAIN" == "$PUBLIC_DOMAIN" ]]; then
    request_cert_if_needed REGIONAL_CERT  "$PUBLIC_DOMAIN" "$AWS_REGION" "Regional cert (public + admin domain)"
    ADMIN_CERT_ARN="$REGIONAL_CERT"
  else
    [[ -n "$HOSTED_ZONE_ID" ]] && request_cert_if_needed REGIONAL_CERT "$PUBLIC_DOMAIN" "$AWS_REGION" "Regional cert (public domain)"
    request_cert_if_needed ADMIN_CERT_ARN "$ADMIN_DOMAIN"  "$AWS_REGION" "Admin domain cert"
  fi
elif [[ -n "$HOSTED_ZONE_ID" ]]; then
  request_cert_if_needed REGIONAL_CERT "$PUBLIC_DOMAIN" "$AWS_REGION" "Regional cert (API DNS record)"
else
  info "No admin domain and no hosted zone — regional cert not needed, skipping."
fi

success "CloudFront cert:  $CF_CERT_ARN"
[[ -n "$REGIONAL_CERT" ]]  && success "Regional cert:    $REGIONAL_CERT"  || true
[[ -n "$ADMIN_DOMAIN" ]]   && success "Admin cert:       $ADMIN_CERT_ARN" || info "Admin cert:       none (HTTP only)"

# ── Summary & confirmation ─────────────────────────────────────────────────────
header "Summary"
echo "  Account:          $ACCOUNT"
echo "  Region:           $AWS_REGION"
echo "  Stage:            $STAGE"
echo "  Frontend VPC:     $PUBLIC_VPC_ID"
echo "  Frontend subnets: $PUBLIC_SUBNET_IDS_STR"
echo "  Admin VPC:        $VPC_ID"
echo "  Admin subnets:    $PRIVATE_SUBNET_IDS_STR"
echo "  CF prefix list:   $CF_PREFIX_LIST_ID"
echo "  Internal CIDR:    $VPN_CIDR"
echo "  Public domain:    $PUBLIC_DOMAIN"
echo "  Admin domain:     ${ADMIN_DOMAIN:-(none - HTTP only via ALB DNS)}"
echo "  Hosted zone:      ${HOSTED_ZONE_ID:-(none - manual DNS)}"
echo "  CF cert:          $CF_CERT_ARN"
echo "  Regional cert:    $REGIONAL_CERT"
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
  --arg frontendVpcId     "$PUBLIC_VPC_ID" \
  --arg frontendSubnetIds "$PUBLIC_SUBNET_IDS_STR" \
  --arg adminVpcId        "$VPC_ID" \
  --arg adminSubnetIds    "$PRIVATE_SUBNET_IDS_STR" \
  --arg cfPrefixListId    "$CF_PREFIX_LIST_ID" \
  --arg vpnCidr           "$VPN_CIDR" \
  --arg publicDomain      "$PUBLIC_DOMAIN" \
  --arg adminDomain       "$ADMIN_DOMAIN" \
  --arg hostedZoneId      "$HOSTED_ZONE_ID" \
  --arg cfCertArn         "$CF_CERT_ARN" \
  --arg regionalCertArn   "$REGIONAL_CERT" \
  --arg adminCertArn      "$ADMIN_CERT_ARN" \
  --arg stage             "$STAGE" \
  '{
    frontendVpcId:          $frontendVpcId,
    frontendSubnetIds:      $frontendSubnetIds,
    adminVpcId:             $adminVpcId,
    adminSubnetIds:         $adminSubnetIds,
    cloudfrontPrefixListId: (if $cfPrefixListId != "" then $cfPrefixListId else null end),
    vpnCidr:                $vpnCidr,
    publicDomain:           (if $publicDomain != "" then $publicDomain else null end),
    adminDomain:            (if $adminDomain   != "" then $adminDomain   else null end),
    hostedZoneId:           (if $hostedZoneId  != "" then $hostedZoneId  else null end),
    cfCertArn:              (if $cfCertArn      != "" then $cfCertArn     else null end),
    regionalCertArn:        (if $regionalCertArn != "" then $regionalCertArn else null end),
    adminCertArn:           (if $adminCertArn   != "" then $adminCertArn  else null end),
    stage:                  $stage
  }' > "$CDK_CONTEXT"
success "cdk.context.json written"

# ── Install npm deps ──────────────────────────────────────────────────────────
header "Installing dependencies"
cd "$SCRIPT_DIR"
# On CloudShell the home dir is only 1 GB — redirect npm cache to /tmp to avoid filling it
if [[ "${AWS_EXECUTION_ENV:-}" == "CloudShell" ]]; then
  export npm_config_cache=/tmp/npm-cache
  info "CloudShell: npm cache redirected to /tmp"
fi
npm install --prefer-offline 2>&1 | tail -20

# ── Pre-deploy orphan cleanup ─────────────────────────────────────────────────
# On a fresh deploy (no stacks exist yet) orphaned resources from previous
# failed attempts block CloudFormation. Purge them proactively.
purge_orphans() {
  local stage="$1"
  info "Checking for orphaned resources from previous deploy attempts..."
  local found=0

  # CloudWatch log groups (Lambda + ECS)
  for prefix in "/aws/lambda/EntraVerifiedID-" "/entra-vid/"; do
    while IFS= read -r lg; do
      [[ -z "$lg" ]] && continue
      warn "Removing orphaned log group: $lg"
      aws logs delete-log-group --log-group-name "$lg" \
        --region "$AWS_REGION" 2>/dev/null || true
      found=1
    done < <(aws logs describe-log-groups \
      --region "$AWS_REGION" \
      --log-group-name-prefix "$prefix" \
      --query "logGroups[?contains(logGroupName, '$stage')].logGroupName" \
      --output text 2>/dev/null | tr '\t' '\n')
  done

  # DynamoDB tables
  while IFS= read -r tbl; do
    [[ -z "$tbl" ]] && continue
    warn "Removing orphaned DynamoDB table: $tbl"
    aws dynamodb delete-table --table-name "$tbl" \
      --region "$AWS_REGION" 2>/dev/null || true
    found=1
  done < <(aws dynamodb list-tables --region "$AWS_REGION" \
    --query "TableNames[?contains(@, '$stage')]" \
    --output text 2>/dev/null | tr '\t' '\n')

  # Secrets Manager secrets — include-planned-deletion catches secrets still in the
  # 7-day recovery window after a previous cdk destroy
  while IFS= read -r secret; do
    [[ -z "$secret" ]] && continue
    warn "Removing orphaned secret: $secret"
    aws secretsmanager delete-secret --secret-id "$secret" \
      --force-delete-without-recovery \
      --region "$AWS_REGION" 2>/dev/null || true
    found=1
  done < <(aws secretsmanager list-secrets --region "$AWS_REGION" \
    --include-planned-deletion \
    --query "SecretList[?contains(Name, '$stage')].Name" \
    --output text 2>/dev/null | tr '\t' '\n')

  # S3 buckets
  while IFS= read -r bucket; do
    [[ -z "$bucket" ]] && continue
    warn "Removing orphaned S3 bucket: $bucket"
    aws s3 rm "s3://$bucket" --recursive 2>/dev/null || true
    aws s3api delete-bucket --bucket "$bucket" \
      --region "$AWS_REGION" 2>/dev/null || true
    found=1
  done < <(aws s3api list-buckets \
    --query "Buckets[?contains(Name, '$stage')].Name" \
    --output text 2>/dev/null | tr '\t' '\n')

  [[ $found -eq 0 ]] && success "No orphaned resources found" || success "Orphan cleanup complete"
}

# Only purge when no stacks exist yet (fresh deploy) or any are in ROLLBACK_COMPLETE
EXISTING_STACKS=$(aws cloudformation list-stacks \
  --region "$AWS_REGION" \
  --query "StackSummaries[?contains(StackName, 'EntraVid-') && contains(StackName, '-${STAGE}') && StackStatus != 'DELETE_COMPLETE'].StackName" \
  --output text 2>/dev/null || echo "")
HAS_ROLLBACK=$(aws cloudformation list-stacks \
  --region "$AWS_REGION" \
  --stack-status-filter ROLLBACK_COMPLETE \
  --query "StackSummaries[?contains(StackName, 'EntraVid-') && contains(StackName, '-${STAGE}')].StackName" \
  --output text 2>/dev/null || echo "")
if [[ -z "$EXISTING_STACKS" ]] || [[ -n "$HAS_ROLLBACK" ]]; then
  purge_orphans "$STAGE"
fi

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
  success "Admin URL:    $ADMIN_URL (accessible from internal network: $VPN_CIDR)"

  if [[ -z "$HOSTED_ZONE_ID" ]]; then
    CF_DOMAIN=$(jq -r ".[\"EntraVid-PublicFrontend-${STAGE}\"].DistributionDomain // \"\"" "$SCRIPT_DIR/cdk-outputs.json")
    ADMIN_ALB=$(jq -r ".[\"EntraVid-Admin-${STAGE}\"].AdminAlbDns               // \"\"" "$SCRIPT_DIR/cdk-outputs.json")
    echo ""
    echo -e "${BOLD}${YELLOW}  ── Manual DNS records required ──────────────────────────────────${RESET}"
    echo "  Add these records to your DNS provider:"
    echo ""
    [[ -n "$CF_DOMAIN" ]]   && echo "    $PUBLIC_DOMAIN  →  ALIAS/CNAME  →  $CF_DOMAIN"
    [[ -n "$ADMIN_ALB" ]]   && echo "    $ADMIN_DOMAIN   →  ALIAS/CNAME  →  $ADMIN_ALB"
    echo ""
  fi

  echo ""
  echo -e "${BOLD}  Next step — initial admin login:${RESET}"
  echo "  1. Connect from your internal network ($VPN_CIDR)"
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
