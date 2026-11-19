'use strict';
// Optional local harness. PGlite is an in-process disposable PostgreSQL engine;
// this runner accepts no database URL and cannot contact production services.
const {PGlite}=require('@electric-sql/pglite');
const fs=require('node:fs');
const path=require('node:path');
(async()=>{
  const db=new PGlite();
  try{
    for(const file of ['tests/delta_schema_fixture.sql','docs/sentlog-delta-v1-schema-prototype.sql',
      'tests/delta_schema_assertions.sql','tests/delta_schema_adversarial.sql']){
      const sql=fs.readFileSync(path.resolve(__dirname,'..',file),'utf8')
        .replace(/^\\set[^\n]*$/mg,'');
      // psql sends top-level statements independently. Preserve explicit
      // transaction boundaries when exec() receives multiple statements.
      for(const block of sql.split(/^(BEGIN;|ROLLBACK;|COMMIT;)$/m)){
        if(!block.trim())continue;
        const result=await db.exec(block);
        for(const part of result)for(const row of part.rows||[])if(row.result)console.log(row.result);
      }
      console.log('PASS '+file);
    }
  }finally{await db.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
