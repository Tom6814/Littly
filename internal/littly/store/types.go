package store

import "time"

const SchemaVersion = 2

type Person struct {
	ID              string    `json:"id"`
	DisplayName     string    `json:"display_name"`
	Nickname        string    `json:"nickname"`
	Timezone        string    `json:"timezone"`
	Channel         string    `json:"channel"` // primary contact channel (web/snowluma)
	ExternalID      string    `json:"external_id"`
	Aliases         []string  `json:"aliases"`
	Tier            string    `json:"tier"`     // stranger|acquaintance|friend|intimate|blocked|archived
	Relationship    string    `json:"relationship"`
	Closeness       int       `json:"closeness"`
	Important       bool      `json:"important"`
	Brief           string    `json:"brief"`
	CardPath        string    `json:"card_path"`
	CardMode        string    `json:"card_mode"` // full|summary|archived
	Notes           string    `json:"notes"`
	Boundaries      string    `json:"boundaries"`
	InteractionCount int      `json:"interaction_count"`
	LastInteractionAt *time.Time `json:"last_interaction_at,omitempty"`
	ArchivedAt      *time.Time `json:"archived_at,omitempty"`
	ArchiveReason   string    `json:"archive_reason"`
	RestoredAt      *time.Time `json:"restored_at,omitempty"`
	RestoreCount    int       `json:"restore_count"`
	CreatedAt       time.Time `json:"created_at"`
	UpdatedAt       time.Time `json:"updated_at"`
}

type Memory struct {
	ID                 string    `json:"id"`
	Domain             string    `json:"domain"` // life|feelings|thoughts|plans|knowledge|routines
	Kind               string    `json:"kind"`   // episodic|semantic|social|reflection
	Title              string    `json:"title"`
	Body               string    `json:"body"`
	EventTime          time.Time `json:"event_time"`
	RecordTime         time.Time `json:"record_time"`
	Importance         int       `json:"importance"` // 1..5
	Visibility         string    `json:"visibility"` // public|relationship|private
	VisibilityPeopleID string    `json:"visibility_people_id,omitempty"`
	Emotion            string    `json:"emotion"`
	PeopleIDs          []string  `json:"people_ids"`
	Source             string    `json:"source"`
	VaultPath          string    `json:"vault_path"`
}

type Activity struct {
	ID         string     `json:"id"`
	Kind       string     `json:"kind"` // learn|research|organize|write|create|maintain|social|rest
	Title      string     `json:"title"`
	Detail     string     `json:"detail"`
	Status     string     `json:"status"` // planned|running|paused|done|failed|cancelled
	Progress   int        `json:"progress"`
	StartedAt  *time.Time `json:"started_at,omitempty"`
	EndedAt    *time.Time `json:"ended_at,omitempty"`
	Summary    string     `json:"summary"`
	ArtifactIDs []string  `json:"artifact_ids"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

type Artifact struct {
	ID         string    `json:"id"`
	ActivityID string    `json:"activity_id,omitempty"`
	Kind       string    `json:"kind"` // file|doc|note|image|post|project
	Title      string    `json:"title"`
	Path       string    `json:"path"`
	Mime       string    `json:"mime"`
	Bytes      int64     `json:"bytes"`
	CreatedAt  time.Time `json:"created_at"`
}

type Heartbeat struct {
	ID            string    `json:"id"`
	Kind          string    `json:"kind"` // self|manual
	DueAt         time.Time `json:"due_at"`
	Reason        string    `json:"reason"`
	Status        string    `json:"status"` // pending|fired|cancelled|superseded|missed|expired
	NoopCount     int       `json:"noop_count"`
	LifetimeUntil *time.Time `json:"lifetime_until,omitempty"`
	CreatedAt     time.Time `json:"created_at"`
	FiredAt       *time.Time `json:"fired_at,omitempty"`
	Meta          map[string]any `json:"meta,omitempty"`
}

type HeartbeatRun struct {
	ID         string     `json:"id"`
	HeartbeatID string    `json:"heartbeat_id,omitempty"`
	Kind       string     `json:"kind"` // self|fallback|event|manual
	StartedAt  time.Time  `json:"started_at"`
	EndedAt    *time.Time `json:"ended_at,omitempty"`
	Outcome    string     `json:"outcome"` // living|progress|done|blocked|resting|needs_attention|noop|interrupted|error
	Notify     *bool      `json:"notify,omitempty"`
	Summary    string     `json:"summary"`
	ModelTurns int        `json:"model_turns"`
	NextDueAt  *time.Time `json:"next_due_at,omitempty"`
	NextReason string     `json:"next_reason"`
	Error      string     `json:"error"`
}

type ReplyDecision struct {
	ID         string         `json:"id"`
	PeopleID   string         `json:"people_id"`
	Channel    string         `json:"channel"`
	InboundRef string         `json:"inbound_ref"`
	ReceivedAt time.Time      `json:"received_at"`
	Factors    map[string]any `json:"factors"`
	Action     string         `json:"action"` // immediate|short|later|no_reply|explain_later
	Reason     string         `json:"reason"`
	DecidedAt  time.Time      `json:"decided_at"`
	SentAt     *time.Time     `json:"sent_at,omitempty"`
	Outcome    string         `json:"outcome"`
}

type Outbox struct {
	ID              string     `json:"id"`
	Kind            string     `json:"kind"` // reply|proactive|explain
	Channel         string     `json:"channel"`
	PeopleID        string     `json:"people_id"`
	ConversationRef string     `json:"conversation_ref"`
	DecisionID      string     `json:"decision_id,omitempty"`
	DueAt           time.Time  `json:"due_at"`
	ExpiresAt       *time.Time `json:"expires_at,omitempty"`
	Status          string     `json:"status"` // draft|queued|sending|sent|failed|cancelled|expired
	Payload         string     `json:"payload"`
	RefType         string     `json:"ref_type"`
	RefID           string     `json:"ref_id"`
	Attempts        int        `json:"attempts"`
	LastError       string     `json:"last_error"`
	SentAt          *time.Time `json:"sent_at,omitempty"`
	CreatedAt       time.Time  `json:"created_at"`
	UpdatedAt       time.Time  `json:"updated_at"`
}

type Message struct {
	ID             string    `json:"id"`
	ConversationID string    `json:"conversation_id"`
	Channel        string    `json:"channel"`
	PeopleID       string    `json:"people_id"`
	Role           string    `json:"role"` // user|assistant|system
	Content        string    `json:"content"`
	At             time.Time `json:"at"`
	ExternalID     string    `json:"external_id,omitempty"`
	ReplyTo        string    `json:"reply_to,omitempty"`
	Direction      string    `json:"direction"` // inbound|outbound
}

type Conversation struct {
	ID           string    `json:"id"`
	Channel      string    `json:"channel"`
	PeopleID     string    `json:"people_id"`
	ExternalKey  string    `json:"external_key"`
	GroupID      string    `json:"group_id,omitempty"`
	Title        string    `json:"title"`
	LastAt       time.Time `json:"last_at"`
}

type Diary struct {
	ID      string    `json:"id"`
	Day     string    `json:"day"` // YYYY-MM-DD, person timezone
	Content string    `json:"content"`
	Mood    string    `json:"mood"`
	Summary string    `json:"summary"`
	At      time.Time `json:"at"`
}

type Dream struct {
	ID        string     `json:"id"`
	StartedAt time.Time  `json:"started_at"`
	EndedAt   *time.Time `json:"ended_at,omitempty"`
	Status    string     `json:"status"` // running|ok|failed
	Summary   string     `json:"summary"`
	Stats     map[string]any `json:"stats"`
}

type Interest struct {
	ID        string    `json:"id"`
	Topic     string    `json:"topic"`
	Summary   string    `json:"summary"`
	Strength  int       `json:"strength"`
	Source    string    `json:"source"`
	Status    string    `json:"status"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Goal struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Detail    string    `json:"detail"`
	Kind      string    `json:"kind"`
	Status    string    `json:"status"`
	Priority  int       `json:"priority"`
	Progress  int       `json:"progress"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Thread struct {
	ID        string    `json:"id"`
	Title     string    `json:"title"`
	Kind      string    `json:"kind"`
	Status    string    `json:"status"`
	PeopleIDs []string  `json:"people_ids"`
	Summary   string    `json:"summary"`
	NextStep  string    `json:"next_step"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type Event struct {
	ID         string    `json:"id"`
	At         time.Time `json:"at"`
	Kind       string    `json:"kind"`
	Title      string    `json:"title"`
	Detail     string    `json:"detail,omitempty"`
	PeopleID   string    `json:"people_id,omitempty"`
	ActivityID string    `json:"activity_id,omitempty"`
}

type RuntimeState struct {
	Energy          int        `json:"energy"`
	Mood            int        `json:"mood"`
	SocialNeed      int        `json:"social_need"`
	Satiety         int        `json:"satiety"`
	Attention       string     `json:"attention"`
	CurrentActivityID string   `json:"current_activity_id,omitempty"`
	LastHeartbeatAt *time.Time `json:"last_heartbeat_at,omitempty"`
	LastWakeAt      *time.Time `json:"last_wake_at,omitempty"`
	LastTickAt      time.Time  `json:"last_tick_at"`
	NoopStreak      int        `json:"noop_streak"`
	HeartbeatPaused bool       `json:"heartbeat_paused"`
}

type State struct {
	Schema        int            `json:"schema"`
	Person        *Person        `json:"person,omitempty"`
	People        []Person       `json:"people"`
	Memories      []Memory       `json:"memories"`
	Activities    []Activity     `json:"activities"`
	Artifacts     []Artifact     `json:"artifacts"`
	Heartbeats    []Heartbeat    `json:"heartbeats"`
	HeartbeatRuns []HeartbeatRun `json:"heartbeat_runs"`
	ReplyDecisions []ReplyDecision `json:"reply_decisions"`
	Outbox        []Outbox       `json:"outbox"`
	Messages      []Message      `json:"messages"`
	Conversations []Conversation `json:"conversations"`
	Diaries       []Diary        `json:"diaries"`
	Dreams        []Dream        `json:"dreams"`
	Interests     []Interest     `json:"interests"`
	Goals         []Goal         `json:"goals"`
	Threads       []Thread       `json:"threads"`
	Events        []Event        `json:"events"`
	Runtime       RuntimeState   `json:"runtime"`
	Meta          map[string]any `json:"meta,omitempty"`
}
