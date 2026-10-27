package handler

import (
	"context"
	"io"
	"log/slog"
	"mime/multipart"
	"net/http"
	"path"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/pkg/errors"
	"golang.org/x/sync/errgroup"

	"github.com/yunboom/marvis/server/internal/kb"
	"github.com/yunboom/marvis/server/internal/storage"
	db "github.com/yunboom/marvis/server/pkg/db/generated"
)

// Error codes of the raw file endpoints.
const (
	kbCodeRawNameTaken   = "raw_name_taken"
	kbCodeRawNameInvalid = "raw_name_invalid"
)

// Query values of GET /api/kb/raw/{id}/content.
const (
	// kbRawFormatURL answers {url} instead of redirecting, for clients whose
	// <img> / <iframe> requests carry no credentials (desktop, split origins).
	kbRawFormatURL = "url"
	kbRawDownload  = "1"
)

// kbRawCapabilityIntent separates raw file capabilities from attachment ones
// in the signed message; kbRawDownloadIntent additionally forces a download.
const (
	kbRawCapabilityIntent = "kb_raw"
	kbRawDownloadIntent   = "kb_raw|" + attachmentCapabilityDownloadIntent
)

// kbRawCleanupTimeout bounds the background removal of deleted raw objects.
const kbRawCleanupTimeout = 5 * time.Minute

// kbRawUploadConcurrency bounds parallel object storage writes of one upload.
const kbRawUploadConcurrency = 4

// KbRawUploadedFile is one file written by an upload.
type KbRawUploadedFile struct {
	ID   string `json:"id"`
	Kind string `json:"kind"`
	Name string `json:"name"`
	URI  string `json:"uri"`
	Size int64  `json:"size"`
}

// KbRawUploadResponse is the body of POST /api/kb/bases/{kb}/raw.
type KbRawUploadResponse struct {
	Files []KbRawUploadedFile `json:"files"`
}

// KbRawFileListItem is one row of the raw files tab.
type KbRawFileListItem struct {
	ID             string `json:"id"`
	Kind           string `json:"kind"`
	Name           string `json:"name"`
	URI            string `json:"uri"`
	ContentType    string `json:"content_type"`
	Size           int64  `json:"size"`
	UploadedBy     string `json:"uploaded_by"`
	UploadedByName string `json:"uploaded_by_name"`
	CreatedAt      string `json:"created_at"`
	// CitedPages counts the live pages whose claims cite the file.
	CitedPages int `json:"cited_pages"`
}

// KbRawContentURLResponse is GET /api/kb/raw/{id}/content?format=url.
type KbRawContentURLResponse struct {
	URL string `json:"url"`
}

// kbRawUpload is one file of an upload, read into memory.
type kbRawUpload struct {
	id          uuid.UUID
	name        string
	key         string
	contentType string
	data        []byte
}

// UploadKbRaw stores raw files of a knowledge base (multipart field file,
// repeatable; kind defaults to source). Any workspace member may upload
// (decision 101); a name already used for the kind answers 409.
func (h *Handler) UploadKbRaw(w http.ResponseWriter, r *http.Request) {
	if h.Storage == nil {
		writeFeatureDisabled(w, "file_upload_not_configured", "file upload not configured")
		return
	}
	userID, ok := requireUserID(w, r)
	if !ok {
		return
	}
	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}

	r.Body = http.MaxBytesReader(w, r.Body, maxUploadSize)
	if err := r.ParseMultipartForm(maxUploadSize); err != nil {
		writeError(w, http.StatusBadRequest, "file too large or invalid multipart form")
		return
	}
	defer func() { _ = r.MultipartForm.RemoveAll() }()

	kind := r.FormValue("kind")
	if kind == "" {
		kind = kb.RawKindSource
	}
	if !kb.ValidRawKind(kind) {
		writeError(w, http.StatusBadRequest, "kind must be source or asset")
		return
	}

	uploads, err := readKbRawUploads(base, kind, r.MultipartForm.File["file"])
	if err != nil {
		h.writeKbError(w, r, err)
		return
	}
	if err := h.checkKbRawNamesFree(r.Context(), base, kind, uploads); err != nil {
		h.writeKbError(w, r, err)
		return
	}

	if err := h.storeKbRawUploads(r.Context(), uploads); err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	rows, err := h.Queries.CreateKbRaws(r.Context(), kbRawRowsParams(base, kind, userID, uploads))
	if err != nil {
		// The objects are useless without their rows.
		h.Storage.DeleteKeys(r.Context(), kbRawUploadKeys(uploads))
		if isUniqueViolation(err) {
			h.writeKbError(w, r, kbFail(http.StatusConflict, kbCodeRawNameTaken, "a file with this name already exists"))
			return
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "create raw files knowledge_base_id=%s", uuidToString(base.ID)))
		return
	}

	resp := KbRawUploadResponse{Files: make([]KbRawUploadedFile, len(rows))}
	for i, row := range rows {
		resp.Files[i] = KbRawUploadedFile{
			ID:   uuidToString(row.ID),
			Kind: row.Kind,
			Name: row.Name,
			URI:  kb.RawURI(row.Kind, row.Name),
			Size: row.Size,
		}
	}

	writeJSON(w, http.StatusCreated, resp)
}

// readKbRawUploads validates the names of an upload and reads the files.
func readKbRawUploads(base db.KbBase, kind string, headers []*multipart.FileHeader) ([]kbRawUpload, error) {
	if len(headers) == 0 {
		return nil, kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "missing file field")
	}

	seen := make(map[string]struct{}, len(headers))
	uploads := make([]kbRawUpload, 0, len(headers))
	for _, header := range headers {
		// Browsers may send a relative path for folder uploads.
		name, ok := kb.CleanRawName(path.Base(strings.ReplaceAll(header.Filename, `\`, "/")))
		if !ok {
			return nil, kbFail(http.StatusBadRequest, kbCodeRawNameInvalid, "file names cannot be empty or contain / \\ # ?")
		}
		if _, dup := seen[name]; dup {
			return nil, kbFail(http.StatusConflict, kbCodeRawNameTaken, "the upload holds two files named "+name)
		}
		seen[name] = struct{}{}

		data, contentType, err := readKbRawFile(header)
		if err != nil {
			return nil, err
		}
		id, err := uuid.NewV7()
		if err != nil {
			return nil, errors.WithStack(err)
		}
		uploads = append(uploads, kbRawUpload{
			id:          id,
			name:        name,
			key:         kbRawStorageKey(base, id, name),
			contentType: contentType,
			data:        data,
		})
	}

	return uploads, nil
}

// kbRawStorageKey places raw files of a knowledge base under one prefix:
// workspaces/<ws>/kb/<kb>/<file id><ext>.
func kbRawStorageKey(base db.KbBase, id uuid.UUID, name string) string {
	return "workspaces/" + uuidToString(base.WorkspaceID) + "/kb/" + uuidToString(base.ID) + "/" + id.String() + path.Ext(name)
}

// readKbRawFile reads one uploaded file and sniffs its content type, the same
// way UploadFile does.
func readKbRawFile(header *multipart.FileHeader) ([]byte, string, error) {
	file, err := header.Open()
	if err != nil {
		return nil, "", kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "failed to read file")
	}
	defer func() { _ = file.Close() }()

	data, err := io.ReadAll(file)
	if err != nil {
		return nil, "", kbFail(http.StatusBadRequest, kbCodeInvalidRequest, "failed to read file")
	}

	contentType := http.DetectContentType(data)
	if ct, ok := extContentTypes[strings.ToLower(path.Ext(header.Filename))]; ok {
		contentType = ct
	}

	return data, contentType, nil
}

func (h *Handler) checkKbRawNamesFree(ctx context.Context, base db.KbBase, kind string, uploads []kbRawUpload) error {
	names := make([]string, len(uploads))
	for i, upload := range uploads {
		names[i] = upload.name
	}

	taken, err := h.Queries.ListKbRawNamesTaken(ctx, db.ListKbRawNamesTakenParams{KnowledgeBaseID: base.ID, Kind: kind, Names: names})
	if err != nil {
		return errors.Wrapf(err, "check raw file names knowledge_base_id=%s", uuidToString(base.ID))
	}
	if len(taken) > 0 {
		sort.Strings(taken)
		reqErr := &kbRequestError{status: http.StatusConflict, code: kbCodeRawNameTaken, message: "a file with this name already exists", extra: map[string]any{"names": taken}}
		return reqErr
	}

	return nil
}

// storeKbRawUploads writes the files to object storage. Object storage has
// no multi-object put, so the writes run in parallel; on failure the objects
// already written are removed.
func (h *Handler) storeKbRawUploads(ctx context.Context, uploads []kbRawUpload) error {
	group, groupCtx := errgroup.WithContext(ctx)
	group.SetLimit(kbRawUploadConcurrency)
	for _, upload := range uploads {
		group.Go(func() error {
			if _, err := h.Storage.Upload(groupCtx, upload.key, upload.data, upload.contentType, upload.name); err != nil {
				return errors.Wrapf(err, "upload raw file name=%q", upload.name)
			}
			return nil
		})
	}

	if err := group.Wait(); err != nil {
		h.Storage.DeleteKeys(ctx, kbRawUploadKeys(uploads))
		return err
	}

	return nil
}

func kbRawUploadKeys(uploads []kbRawUpload) []string {
	keys := make([]string, len(uploads))
	for i, upload := range uploads {
		keys[i] = upload.key
	}

	return keys
}

func kbRawRowsParams(base db.KbBase, kind, userID string, uploads []kbRawUpload) db.CreateKbRawsParams {
	params := db.CreateKbRawsParams{
		WorkspaceID:     base.WorkspaceID,
		KnowledgeBaseID: base.ID,
		Kind:            kind,
		UploadedBy:      parseUUID(userID),
		Ids:             make([]pgtype.UUID, len(uploads)),
		Names:           make([]string, len(uploads)),
		StorageKeys:     make([]string, len(uploads)),
		Sizes:           make([]int64, len(uploads)),
		ContentTypes:    make([]string, len(uploads)),
	}
	for i, upload := range uploads {
		params.Ids[i] = pgtype.UUID{Bytes: upload.id, Valid: true}
		params.Names[i] = upload.name
		params.StorageKeys[i] = upload.key
		params.Sizes[i] = int64(len(upload.data))
		params.ContentTypes[i] = upload.contentType
	}

	return params
}

// ListKbRaw lists the raw files of a knowledge base, newest first, with how
// many live pages cite each one.
func (h *Handler) ListKbRaw(w http.ResponseWriter, r *http.Request) {
	base, ok := h.loadKbBaseForUser(w, r, chi.URLParam(r, "kb"))
	if !ok {
		return
	}

	kind := r.URL.Query().Get("kind")
	if kind != "" && !kb.ValidRawKind(kind) {
		writeError(w, http.StatusBadRequest, "kind must be source or asset")
		return
	}

	rows, err := h.Queries.ListKbRaws(r.Context(), db.ListKbRawsParams{KnowledgeBaseID: base.ID, Kind: optionalText(kind)})
	if err != nil {
		h.writeKbInternalError(w, r, errors.Wrapf(err, "list raw files knowledge_base_id=%s", uuidToString(base.ID)))
		return
	}
	cited, err := h.loadKbRawCitedPages(r.Context(), base.ID)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	resp := make([]KbRawFileListItem, len(rows))
	for i, row := range rows {
		resp[i] = KbRawFileListItem{
			ID:             uuidToString(row.ID),
			Kind:           row.Kind,
			Name:           row.Name,
			URI:            kb.RawURI(row.Kind, row.Name),
			ContentType:    row.ContentType,
			Size:           row.Size,
			UploadedBy:     uuidToString(row.UploadedBy),
			UploadedByName: row.UploadedByName,
			CreatedAt:      timestampToString(row.CreatedAt),
			CitedPages:     len(cited[row.Kind+"/"+row.Name]),
		}
	}

	writeJSON(w, http.StatusOK, resp)
}

// loadKbRawCitedPages maps "<kind>/<name>" to the live pages whose claims
// cite that raw file; uris are parsed here so escaped names and #page=
// fragments count as the same file.
func (h *Handler) loadKbRawCitedPages(ctx context.Context, baseID pgtype.UUID) (map[string]map[string]struct{}, error) {
	rows, err := h.Queries.ListKbRawCitations(ctx, baseID)
	if err != nil {
		return nil, errors.Wrapf(err, "list raw citations knowledge_base_id=%s", uuidToString(baseID))
	}

	out := make(map[string]map[string]struct{})
	for _, row := range rows {
		ref, ok := kb.ParseRawURI(row.Uri)
		if !ok {
			continue
		}
		key := ref.Kind + "/" + ref.Name
		if out[key] == nil {
			out[key] = map[string]struct{}{}
		}
		out[key][uuidToString(row.PageID)] = struct{}{}
	}

	return out, nil
}

func optionalText(value string) pgtype.Text {
	return pgtype.Text{String: value, Valid: value != ""}
}

// GetKbRawContent serves a raw file for preview and download: a 302 to a
// short-lived signed storage URL, or the bytes themselves when storage is
// local or private (proxy mode). download=1 forces an attachment;
// format=url answers {url} with a URL that needs no credentials.
func (h *Handler) GetKbRawContent(w http.ResponseWriter, r *http.Request) {
	wsUUID, ok := parseUUIDOrBadRequest(w, h.resolveWorkspaceID(r), "workspace_id")
	if !ok {
		return
	}
	rawUUID, ok := parseUUIDOrBadRequest(w, chi.URLParam(r, "id"), "id")
	if !ok {
		return
	}
	raw, err := h.Queries.GetKbRawInWorkspace(r.Context(), db.GetKbRawInWorkspaceParams{WorkspaceID: wsUUID, ID: rawUUID})
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "raw file not found")
			return
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load raw file id=%s", uuidToString(rawUUID)))
		return
	}
	if h.Storage == nil {
		writeFeatureDisabled(w, "storage_not_configured", "storage not configured")
		return
	}

	download := r.URL.Query().Get("download") == kbRawDownload
	wantURL := r.URL.Query().Get("format") == kbRawFormatURL
	signedURL, proxy, err := h.signKbRawURL(r.Context(), raw, download)
	if err != nil {
		h.writeKbInternalError(w, r, err)
		return
	}

	switch {
	case wantURL && proxy:
		writeJSON(w, http.StatusOK, KbRawContentURLResponse{URL: kbRawCapabilityPath(uuidToString(raw.ID), download, time.Now().Add(h.attachmentDownloadURLTTL()))})
	case wantURL:
		writeJSON(w, http.StatusOK, KbRawContentURLResponse{URL: signedURL})
	case proxy:
		h.proxyAttachmentDownload(w, r, kbRawAttachment(raw), raw.StorageKey, download)
	default:
		h.setAttachmentPreviewSecurityHeaders(w)
		http.Redirect(w, r, signedURL, http.StatusFound)
	}
}

// signKbRawURL picks how a raw file is served, the same way attachments are
// (resolveAttachmentDownloadMode): a CloudFront or presigned URL, or proxy
// when neither applies. proxy=true means there is no signed URL.
func (h *Handler) signKbRawURL(ctx context.Context, raw db.KbRaw, download bool) (string, bool, error) {
	objectURL := h.Storage.ObjectURL(raw.StorageKey)
	disposition := ""
	if download {
		disposition = storage.AttachmentContentDisposition(raw.Name)
	}

	switch h.resolveAttachmentDownloadMode(objectURL) {
	case attachmentDownloadModeCloudFront:
		if h.CFSigner == nil {
			return "", true, nil
		}
		if disposition == "" {
			disposition = storage.ContentDisposition(raw.ContentType, raw.Name)
		}

		return h.CFSigner.SignedURLWithContentDisposition(objectURL, disposition, time.Now().Add(h.attachmentDownloadURLTTL())), false, nil
	case attachmentDownloadModePresign:
		presigner, ok := h.Storage.(storage.DownloadPresigner)
		if !ok {
			return "", true, nil
		}
		signed, err := presigner.PresignGetWithContentDisposition(ctx, raw.StorageKey, h.attachmentDownloadURLTTL(), disposition)
		if err != nil {
			return "", false, errors.Wrapf(err, "presign raw file id=%s", uuidToString(raw.ID))
		}

		return signed, false, nil
	default:
		return "", true, nil
	}
}

// kbRawAttachment adapts a raw file to the attachment streaming helpers.
func kbRawAttachment(raw db.KbRaw) db.Attachment {
	return db.Attachment{
		ID:          raw.ID,
		WorkspaceID: raw.WorkspaceID,
		Filename:    raw.Name,
		ContentType: raw.ContentType,
		SizeBytes:   raw.Size,
	}
}

// kbRawCapabilityPath is the credential-free URL of a raw file in proxy mode:
// the same signed capability as attachment downloads, bound to the raw file
// id and a distinct intent. It lives as long as a presigned URL because a
// PDF preview keeps reading ranges while it is open.
func kbRawCapabilityPath(rawID string, download bool, expiry time.Time) string {
	intent := kbRawCapabilityIntent
	query := ""
	if download {
		intent = kbRawDownloadIntent
		query = "&dl=1"
	}
	exp := expiry.Unix()

	return "/api/kb/raw/" + rawID + "/signed-content?exp=" + strconv.FormatInt(exp, 10) +
		"&sig=" + signAttachmentCapabilityIntent(rawID, exp, intent) + query
}

// GetKbRawContentWithCapability serves a raw file to a request that carries
// a capability from format=url instead of credentials. Registered as a
// public route, like DownloadAttachmentWithCapability.
func (h *Handler) GetKbRawContentWithCapability(w http.ResponseWriter, r *http.Request) {
	rawID := chi.URLParam(r, "id")
	query := r.URL.Query()
	intent := kbRawCapabilityIntent
	if query.Get("dl") == kbRawDownload {
		intent = kbRawDownloadIntent
	}
	if !verifyAttachmentCapability(rawID, query.Get("exp"), query.Get("sig"), intent, time.Now()) {
		writeError(w, http.StatusForbidden, "invalid or expired download link")
		return
	}

	rawUUID, ok := parseUUIDOrBadRequest(w, rawID, "id")
	if !ok {
		return
	}
	raw, err := h.Queries.GetKbRawByID(r.Context(), rawUUID)
	if err != nil {
		if isNotFound(err) {
			writeError(w, http.StatusNotFound, "raw file not found")
			return
		}
		h.writeKbInternalError(w, r, errors.Wrapf(err, "load raw file id=%s", rawID))
		return
	}
	if h.Storage == nil {
		writeFeatureDisabled(w, "storage_not_configured", "storage not configured")
		return
	}

	w.Header().Set("Referrer-Policy", "no-referrer")
	h.proxyAttachmentDownload(w, r, kbRawAttachment(raw), raw.StorageKey, intent == kbRawDownloadIntent)
}

// deleteKbRawObjects removes raw file objects after the rows are gone. It
// runs detached from the request: the response does not wait for storage.
// Storage.DeleteKeys is the batch call (the S3 backend issues one delete per
// key; there is no multi-object delete in the Storage interface).
func (h *Handler) deleteKbRawObjects(keys []string) {
	if h.Storage == nil || len(keys) == 0 {
		return
	}

	store := h.Storage
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), kbRawCleanupTimeout)
		defer cancel()
		store.DeleteKeys(ctx, keys)
		slog.Info("knowledge base raw objects deleted", "count", len(keys))
	}()
}
