import os
import pymysql
from dotenv import load_dotenv

# Load environment variables
backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
env_path = os.path.join(backend_dir, '.env')
load_dotenv(env_path)

DB_HOST = os.getenv('DB_HOST', 'localhost')
DB_PORT = int(os.getenv('DB_PORT', 3306))
DB_USER = os.getenv('DB_USER', 'root')
DB_PASSWORD = os.getenv('DB_PASSWORD', 'rolex')
DB_NAME = os.getenv('DB_NAME', 'scmmallavali')

print(f"[*] Running database setup on {DB_HOST}:{DB_PORT}/{DB_NAME} ...")

SQL_STATEMENTS = [
    # 1. vehicle_issues
    """
    CREATE TABLE IF NOT EXISTS `vehicle_issues` (
        `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
        `issue_number` VARCHAR(50) NOT NULL UNIQUE,
        `indent_id` BIGINT NULL,
        `warehouse_id` BIGINT NOT NULL,
        `vehicle_code` VARCHAR(50) NOT NULL,
        `vehicle_number` VARCHAR(50) NOT NULL,
        `issue_date` DATETIME NOT NULL,
        `department` VARCHAR(100) NULL,
        `issued_to` BIGINT NULL,
        `status` VARCHAR(50) NOT NULL DEFAULT 'draft',
        `remarks` TEXT NULL,
        `issued_by` BIGINT NULL,
        `project_id` BIGINT NULL,
        `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
        `updated_at` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (`indent_id`) REFERENCES `indents` (`id`),
        FOREIGN KEY (`warehouse_id`) REFERENCES `warehouses` (`id`),
        FOREIGN KEY (`issued_to`) REFERENCES `users` (`id`),
        FOREIGN KEY (`issued_by`) REFERENCES `users` (`id`),
        FOREIGN KEY (`project_id`) REFERENCES `projects` (`id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    """,
    
    # 2. vehicle_issue_items
    """
    CREATE TABLE IF NOT EXISTS `vehicle_issue_items` (
        `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
        `vehicle_issue_id` BIGINT NOT NULL,
        `item_id` BIGINT NOT NULL,
        `batch_id` BIGINT NULL,
        `qty` DECIMAL(15, 3) NOT NULL,
        `uom_id` BIGINT NOT NULL,
        `bin_id` BIGINT NULL,
        `rate` DECIMAL(15, 2) NOT NULL DEFAULT 0,
        `amount` DECIMAL(15, 2) NOT NULL DEFAULT 0,
        `serial_numbers` JSON NULL,
        `batch_number_text` VARCHAR(100) NULL,
        `bin_code_text` VARCHAR(100) NULL,
        FOREIGN KEY (`vehicle_issue_id`) REFERENCES `vehicle_issues` (`id`) ON DELETE CASCADE,
        FOREIGN KEY (`item_id`) REFERENCES `items` (`id`),
        FOREIGN KEY (`batch_id`) REFERENCES `batches` (`id`),
        FOREIGN KEY (`uom_id`) REFERENCES `uom` (`id`),
        FOREIGN KEY (`bin_id`) REFERENCES `warehouse_bins` (`id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    """,
    
    # 3. vehicle_stock_balance
    """
    CREATE TABLE IF NOT EXISTS `vehicle_stock_balance` (
        `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
        `vehicle_code` VARCHAR(50) NOT NULL,
        `vehicle_number` VARCHAR(50) NOT NULL,
        `item_id` BIGINT NOT NULL,
        `batch_id` BIGINT NULL,
        `qty` DECIMAL(15, 3) NOT NULL DEFAULT 0,
        `last_updated` DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        FOREIGN KEY (`item_id`) REFERENCES `items` (`id`),
        FOREIGN KEY (`batch_id`) REFERENCES `batches` (`id`),
        UNIQUE KEY `uq_vehicle_stock_balance_key` (`vehicle_code`, `item_id`, `batch_id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    """,
    
    # 4. material_acknowledgements
    """
    CREATE TABLE IF NOT EXISTS `material_acknowledgements` (
        `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
        `acknowledgement_number` VARCHAR(50) NOT NULL UNIQUE,
        `vehicle_issue_id` BIGINT NOT NULL,
        `acknowledged_by` BIGINT NOT NULL,
        `employee_code` VARCHAR(100) NULL,
        `remarks` TEXT NULL,
        `status` VARCHAR(50) NOT NULL DEFAULT 'acknowledged',
        `acknowledged_at` DATETIME NOT NULL,
        `created_at` DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (`vehicle_issue_id`) REFERENCES `vehicle_issues` (`id`),
        FOREIGN KEY (`acknowledged_by`) REFERENCES `users` (`id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    """,
    
    # 5. material_acknowledgement_items
    """
    CREATE TABLE IF NOT EXISTS `material_acknowledgement_items` (
        `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
        `acknowledgement_id` BIGINT NOT NULL,
        `item_id` BIGINT NOT NULL,
        `received_qty` DECIMAL(15, 3) NOT NULL,
        `remarks` TEXT NULL,
        `serial_numbers` JSON NULL,
        FOREIGN KEY (`acknowledgement_id`) REFERENCES `material_acknowledgements` (`id`) ON DELETE CASCADE,
        FOREIGN KEY (`item_id`) REFERENCES `items` (`id`)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    """
]

def main():
    conn = pymysql.connect(
        host=DB_HOST,
        port=DB_PORT,
        user=DB_USER,
        password=DB_PASSWORD,
        database=DB_NAME,
        autocommit=True
    )
    cursor = conn.cursor()
    try:
        for idx, statement in enumerate(SQL_STATEMENTS, 1):
            print(f"[~] Executing statement {idx} ...")
            cursor.execute(statement)
        print("[+] All database tables created successfully.")
    except Exception as e:
        print(f"[!] Table creation failed: {e}")
        raise
    finally:
        cursor.close()
        conn.close()

if __name__ == "__main__":
    main()
