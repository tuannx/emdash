// Conservative limits keep a request below Cloudflare D1's free-plan query
// ceiling even though plugin storage expands putMany into individual writes.
export var PROFILE_BATCH_LIMIT = 20;
export var STATIC_MEMBERSHIP_BATCH_LIMIT = 10;
export var USER_MIGRATION_PAGE_LIMIT = 30;
export var SEGMENT_RECOMPUTE_PAGE_LIMIT = 28;
export var READ_PAGE_LIMIT = 50;
