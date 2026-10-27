package landiscovery

import (
	"context"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/pkg/errors"
)

const (
	// ensureInstanceStateSQL 保证单行表里有一行，首次启动或多副本同时启动都安全。
	ensureInstanceStateSQL = `
		INSERT INTO instance_telemetry_state (singleton)
		VALUES (true)
		ON CONFLICT (singleton) DO NOTHING`

	// selectInstanceIDSQL 读取实例 ID。
	selectInstanceIDSQL = `
		SELECT instance_id
		  FROM instance_telemetry_state
		 WHERE singleton = true`
)

// LoadInstanceID 读取本部署的实例 ID，复用遥测的单行表 instance_telemetry_state，行不存在时先创建。
func LoadInstanceID(ctx context.Context, pool *pgxpool.Pool) (string, error) {
	if _, err := pool.Exec(ctx, ensureInstanceStateSQL); err != nil {
		return "", errors.Wrap(err, "ensure instance state row")
	}

	var instanceID uuid.UUID
	if err := pool.QueryRow(ctx, selectInstanceIDSQL).Scan(&instanceID); err != nil {
		return "", errors.Wrap(err, "load instance id")
	}

	return instanceID.String(), nil
}
